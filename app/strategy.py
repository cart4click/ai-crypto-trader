"""Strategy engine ("the bot").

Per configured coin:
- BUY signal  when price <= anchor_price * (1 - buy_dip_pct/100)   (default 6%)
- SELL signal when price >= avg_cost    * (1 + sell_high_pct/100)  (default 6%)

When a signal fires, the AI forecast layer is consulted:
- BUY:  if the AI expects an even deeper dip (P(another -2%) high AND trend not
  bullish) it recommends WAIT; otherwise PROCEED.
- SELL: if the AI expects a higher high (P(+2% more) high AND bullish trend AND
  news not bearish) it recommends WAIT; otherwise PROCEED.

Execution policy:
- DRY_RUN=true  : signals are executed immediately as simulated paper trades
                  (if AI says WAIT, the trade is skipped and logged).
- DRY_RUN=false : every order needs explicit confirmation, either from the
                  private Telegram chat (Confirm/Cancel buttons) or from the
                  web dashboard. Pending orders expire after 15 minutes and are
                  cancelled automatically if the price drifted >1.5% from the
                  signal price.
"""
import asyncio
import datetime as dt
import logging
import time
import uuid

from . import forecast, news as news_mod
from .binance_client import BinanceClient, BinanceError
from .config import has_ai_providers, settings
from .state_store import StateStore
from .telegram_bot import TelegramBot
from .trader import Trader
from .whale_monitor import WhaleMonitor

log = logging.getLogger("bot")

PENDING_TTL_MIN = 15
DRIFT_GUARD = 0.015  # cancel if price moved >1.5% from the signal


def fmt_usd(x: float) -> str:
    if x is None:
        return "—"
    if abs(x) >= 1000:
        return f"${x:,.0f}"
    return f"${x:,.2f}"


def score_emoji(score: float) -> str:
    if score > 0.12:
        return "🟢 Bullish"
    if score < -0.12:
        return "🔴 Bearish"
    return "⚪ Neutral"


def now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


class BotRunner:
    def __init__(self):
        self.binance = BinanceClient()
        self.state = StateStore(str(settings.data_dir / "state.json"))
        self.trader = Trader(self.binance, self.state)
        self.telegram = TelegramBot()
        self.whale_monitor = WhaleMonitor()
        self.running = False
        self.started_at: str | None = None
        self._loop_task: asyncio.Task | None = None
        self._bg_tasks: list[asyncio.Task] = []
        self._news_cache = {"ts": 0.0, "data": None, "symbols": []}
        self._last_signal: dict[str, float] = {}

    # ------------------------------------------------------------------ life
    async def setup(self):
        await self.state.load()
        # Telegram poller runs independently of the bot loop so pending
        # confirmations can be answered at any time.
        self._bg_tasks.append(asyncio.create_task(self._telegram_loop()))

    async def shutdown(self):
        self.running = False
        for t in self._bg_tasks:
            t.cancel()
        if self._loop_task:
            self._loop_task.cancel()
        await self.binance.close()
        await self.telegram.close()
        await self.whale_monitor.close()

    async def start_bot(self):
        if self.running:
            return
        self.running = True
        self.started_at = now_iso()
        self._loop_task = asyncio.create_task(self._loop())
        await self.telegram.broadcast(
            "🤖 <b>Bot STARTED</b>\n"
            f"Mode: {'🧪 DRY RUN (paper)' if settings.dry_run else '💰 LIVE'}\n"
            f"Watching: {', '.join(self.state.snapshot()['coins'].keys()) or 'no coins yet'}"
        )
        log.info("Bot started")

    async def stop_bot(self):
        if not self.running:
            return
        self.running = False
        if self._loop_task:
            self._loop_task.cancel()
            self._loop_task = None
        await self.telegram.broadcast("🛑 <b>Bot PAUSED</b> — no new signals will fire. Use /resume or the dashboard to restart.")
        log.info("Bot stopped")

    # ------------------------------------------------------------------ loop
    async def _loop(self):
        log.info("Strategy loop running (every %ss)", settings.poll_seconds)
        try:
            while self.running:
                try:
                    await self._tick()
                except Exception:
                    log.exception("tick failed")
                await asyncio.sleep(settings.poll_seconds)
        except asyncio.CancelledError:
            pass

    async def _news(self, symbols: list[str]) -> dict:
        now = time.time()
        cached = self._news_cache
        if cached["data"] and now - cached["ts"] < 900 and set(symbols) <= set(cached["symbols"]):
            return cached["data"]
        try:
            data = await news_mod.fetch_news(symbols)
            # Enhance with whale data
            whale_transactions = await self.whale_monitor.fetch_whale_transactions(symbols)
            data["whale_data"] = {}
            for symbol in symbols:
                txs = whale_transactions.get(symbol, [])
                whale_analysis = self.whale_monitor.analyze_whale_sentiment(txs)
                data["whale_data"][symbol] = whale_analysis
                
            self._news_cache = {"ts": now, "data": data, "symbols": symbols}
            return data
        except Exception as e:
            log.warning("news fetch failed: %s", e)
            return cached["data"] or {
                "market": {"score": 0.0, "label": "Unknown"}, "coins": {}, "items": [],
                "ai": {"enabled": bool(settings.ai_api_key)}, "fear_greed": None,
                "whale_data": {s: {"score": 0.0, "label": "Neutral", "count": 0} for s in symbols}
            }

    async def _tick(self):
        snap = self.state.snapshot()
        symbols = [s for s, c in snap["coins"].items() if c.get("enabled")]
        if not symbols:
            return
        news = await self._news(symbols)
        for symbol in symbols:
            coin = snap["coins"][symbol]
            try:
                price = await self.binance.ticker_price(symbol)
            except BinanceError as e:
                log.warning("%s price failed: %s", symbol, e)
                continue

            if not coin.get("anchor_price"):
                await self.state.update_coin(symbol, anchor_price=price)
                log.info("%s anchor price set to %s", symbol, fmt_usd(price))
                continue

            anchor = coin["anchor_price"]
            qty, avg = coin.get("qty", 0.0), coin.get("avg_cost", 0.0)
            buy_target = anchor * (1 - coin["buy_dip_pct"] / 100.0)
            sell_target = avg * (1 + coin["sell_high_pct"] / 100.0) if qty > 0 and avg > 0 else None

            signal = None
            if sell_target and price >= sell_target:
                signal = ("SELL", sell_target)
            elif price <= buy_target:
                signal = ("BUY", buy_target)
            if not signal:
                continue

            key = f"{symbol}:{signal[0]}"
            if time.time() - self._last_signal.get(key, 0) < 300:
                continue  # de-dupe: at most one signal per side per 5 minutes
            self._last_signal[key] = time.time()

            await self._handle_signal(symbol, signal[0], price, signal[1], news, source="bot")

    # -------------------------------------------------------------- signals
    def _ai_decision(self, side: str, target: float, f: dict, probs: dict, news_score: float, whale_score: float = 0.0, market_impact: str = "none") -> dict:
        trend = f["trend"]
        
        # Enhanced decision making with whale sentiment
        whale_confidence = abs(whale_score)
        whale_bullish = whale_score > 0.3
        whale_bearish = whale_score < -0.3
        
        # Market-wide impact consideration
        high_market_impact = market_impact in ["high", "extreme"]
        
        if side == "BUY":
            p_deeper = probs.get("below_deeper", 0.0)
            deeper_pct = (target - f["predicted_low"]) / target * 100 if target > 0 else 0
            
            # Whale-influenced decision with market-wide consideration
            if whale_bearish and whale_confidence > 0.5:
                market_reason = f"market-wide {market_impact} impact" if high_market_impact else "whale activity"
                return {
                    "action": "wait",
                    "reason": (f"{market_reason} bearish (score: {whale_score:.2f}) — "
                              f"large sell signals detected, waiting for better entry"),
                }
            if whale_bullish and whale_confidence > 0.5:
                market_reason = f"market-wide {market_impact} support" if high_market_impact else "whale activity"
                return {
                    "action": "proceed",
                    "reason": (f"{market_reason} bullish (score: {whale_score:.2f}) — "
                              f"large buy signals support this entry, "
                              f"P(another −2%): {p_deeper:.0%}, trend {trend}"),
                }
            if p_deeper >= 0.55 and trend != "bullish":
                return {
                    "action": "wait",
                    "reason": (f"expects a deeper dip — 24h low forecast {fmt_usd(f['predicted_low'])} "
                               f"({deeper_pct:.1f}% below target), P(another −2%): {p_deeper:.0%}, trend {trend}"),
                }
            return {
                "action": "proceed",
                "reason": (f"no clearly deeper dip expected — P(another −2%): {p_deeper:.0%}, "
                           f"trend {trend}, 24h low forecast {fmt_usd(f['predicted_low'])}"),
            }
        p_higher = probs.get("above_higher", 0.0)
        higher_pct = (f["predicted_high"] - target) / target * 100 if target else 0
        
        # Whale-influenced SELL decision with market-wide consideration
        if whale_bullish and whale_confidence > 0.5:
            market_reason = f"market-wide {market_impact} support" if high_market_impact else "whale activity"
            return {
                "action": "wait",
                "reason": (f"{market_reason} bullish (score: {whale_score:.2f}) — "
                          f"large buy signals detected, may push price higher"),
            }
        if whale_bearish and whale_confidence > 0.5:
            market_reason = f"market-wide {market_impact} pressure" if high_market_impact else "whale activity"
            return {
                "action": "proceed",
                "reason": (f"{market_reason} bearish (score: {whale_score:.2f}) — "
                          f"large sell signals support exiting position"),
            }
        if p_higher >= 0.55 and trend == "bullish" and news_score >= -0.1:
            return {
                "action": "wait",
                "reason": (f"expects a higher high — 24h high forecast {fmt_usd(f['predicted_high'])} "
                           f"(+{higher_pct:.1f}% above target), P(+2% more): {p_higher:.0%}, trend {trend}"),
            }
        return {
            "action": "proceed",
            "reason": (f"limited upside left — P(+2% more): {p_higher:.0%}, trend {trend}, "
                       f"24h high forecast {fmt_usd(f['predicted_high'])}"),
        }

    async def _handle_signal(self, symbol: str, side: str, price: float, target: float,
                             news: dict, source: str):
        # skip if an identical pending order is already open
        for p in self.state.snapshot()["pending"].values():
            if p["symbol"] == symbol and p["side"] == side and p["status"] == "pending":
                return

        f = await forecast.get_forecast(self.binance, symbol)
        if side == "BUY":
            probs = await forecast.probs_for(self.binance, symbol, {
                "below_target": (price, "below"),
                "below_deeper": (target * 0.98, "below"),
            })
        else:
            probs = await forecast.probs_for(self.binance, symbol, {
                "above_target": (price, "above"),
                "above_higher": (target * 1.02, "above"),
            })

        coin_news = news.get("coins", {}).get(symbol, {})
        news_score = float(coin_news.get("score", 0.0))
        
        # Get whale sentiment (combined coin-specific + market-wide)
        whale_data = news.get("whale_data", {}).get(symbol, {})
        whale_score = float(whale_data.get("combined_score", whale_data.get("score", 0.0)))
        market_impact = whale_data.get("market_impact", "none")
        
        decision = self._ai_decision(side, target, f, probs, news_score, whale_score, market_impact)
        coin_cfg = self.state.snapshot()["coins"][symbol]

        # Multi-factor AI advisor (LLM when configured, else rule-based):
        # weighs technicals + forecast + news + Fear&Greed into BUY/SELL/HOLD.
        try:
            from . import ai_advisor
            advice = await ai_advisor.get_advice(self.binance, self._news, symbol)
            advisor_summary = {"action": advice["action"],
                               "confidence": advice.get("confidence", 0.5),
                               "summary": advice.get("summary", ""),
                               "factors": advice.get("factors", [])[:6]}
        except Exception as e:
            log.warning("advisor failed for %s: %s", symbol, e)
            advisor_summary = None

        pend = {
            "id": uuid.uuid4().hex[:10],
            "symbol": symbol,
            "side": side,
            "signal_price": price,
            "target_price": round(target, 8),
            "amount_usdt": coin_cfg["trade_amount_usdt"] if side == "BUY" else None,
            "qty": None,
            "signal_source": source,  # "bot", "manual", "telegram"
            "ai_influence": "high" if decision["action"] != "proceed" else "medium",
            "ai": {
                "decision": decision["action"],
                "reason": decision["reason"],
                "trend": f["trend"],
                "predicted_low": round(f["predicted_low"], 8),
                "predicted_high": round(f["predicted_high"], 8),
                "probs": {k: round(v, 3) for k, v in probs.items()},
                "advisor": advisor_summary,
            },
            "news_score": news_score,
            "source": source,
            "created_at": now_iso(),
            "expires_at": (dt.datetime.now() + dt.timedelta(minutes=PENDING_TTL_MIN)).isoformat(timespec="seconds"),
            "status": "pending",
        }
        await self.state.add_pending(pend)
        log.info("%s signal %s @ %s (target %s) — AI says %s",
                 side, symbol, fmt_usd(price), fmt_usd(target), decision["action"])

        if settings.dry_run:
            if decision["action"] == "wait":
                await self.state.update_pending(pend["id"], status="ai_waited")
                await self.telegram.broadcast(
                    f"⏳ <b>{side} signal on {symbol} — AI says WAIT (dry run, no trade)</b>\n"
                    f"🤖 {decision['reason']}\n"
                    f"Signal price: {fmt_usd(price)} (target {fmt_usd(target)})"
                )
            else:
                await self.confirm_pending(pend["id"], source=f"{source}/dry-run")
            return

        # LIVE mode: confirmation required
        markup = {"inline_keyboard": [[
            {"text": "✅ Confirm", "callback_data": f"confirm:{pend['id']}"},
            {"text": "❌ Cancel", "callback_data": f"cancel:{pend['id']}"},
        ]]}
        sent = False
        if self.telegram.ready:
            await self.telegram.broadcast(self._signal_text(pend), markup)
            sent = True
        if decision["action"] == "wait":
            await self.state.update_pending(pend["id"], status="pending",
                                            **{"ai.hint": "AI suggests waiting — confirm anyway?"})
        if not sent:
            log.warning("LIVE signal %s %s waiting for confirmation on the web dashboard "
                        "(Telegram not configured)", side, symbol)

    def _signal_text(self, p: dict) -> str:
        emoji = "🟢" if p["side"] == "BUY" else "🔴"
        ai = p["ai"]
        lines = [
            f"{emoji} <b>{p['side']} signal — {p['symbol']}</b>",
            f"Signal price: <b>{fmt_usd(p['signal_price'])}</b> (trigger {fmt_usd(p['target_price'])})",
        ]
        if p["side"] == "BUY":
            lines.append(f"Order: BUY {fmt_usd(p['amount_usdt'])} of {p['symbol']} (market)")
        else:
            lines.append(f"Order: SELL position of {p['symbol']} (market)")
        lines.append(f"🤖 AI {ai['decision'].upper()}: {ai['reason']}")
        adv = ai.get("advisor")
        if adv:
            lines.append(f"🧠 Advisor: <b>{adv['action']}</b> ({adv['confidence']:.0%} confidence)")
            lines.append(f"    {adv['summary']}")
            for fac in adv.get("factors", []):
                lines.append(f"    • {fac.get('factor')}: {fac.get('view')} — {fac.get('detail')}")
        lines.append(f"📰 News: {score_emoji(p['news_score'])}")
        lines.append(f"⏳ Expires {p['expires_at'][:16].replace('T', ' ')}")
        lines.append(f"Mode: {'🧪 DRY RUN' if settings.dry_run else '💰 LIVE'}")
        return "\n".join(lines)

    # --------------------------------------------------------- confirmations
    async def confirm_pending(self, pid: str, source: str):
        pend = self.state.get_pending(pid)
        if not pend or pend["status"] != "pending":
            return
        if pend["expires_at"] and pend["expires_at"] < now_iso():
            await self._mark(pid, "expired")
            await self.telegram.broadcast(f"⌛ Order {pid} expired (not confirmed in time).")
            return
        symbol, side = pend["symbol"], pend["side"]
        price_now = await self.binance.ticker_price(symbol)
        if side == "BUY" and price_now > pend["signal_price"] * (1 + DRIFT_GUARD):
            await self._mark(pid, "cancelled",
                             note=f"auto-cancel: price moved up to {fmt_usd(price_now)} since signal")
            await self.telegram.broadcast(
                f"🚫 {symbol} BUY cancelled — price moved to {fmt_usd(price_now)} since the signal.")
            return
        if side == "SELL" and price_now < pend["signal_price"] * (1 - DRIFT_GUARD):
            await self._mark(pid, "cancelled",
                             note=f"auto-cancel: price moved down to {fmt_usd(price_now)} since signal")
            await self.telegram.broadcast(
                f"🚫 {symbol} SELL cancelled — price moved to {fmt_usd(price_now)} since the signal.")
            return
        await self._mark(pid, "executing")
        try:
            trade = await self.trader.execute(
                symbol, side, usdt=pend["amount_usdt"], qty=pend["qty"],
                meta={"pending_id": pid, "source": source, "ai": pend["ai"]},
            )
            await self.state.update_pending(pid, status="executed", trade_id=trade["id"])
            msg = [f"✅ <b>Executed {side} {symbol}</b>",
                   f"Price: {fmt_usd(trade['price'])}  Qty: {trade['qty']:.8f}",
                   f"Value: {fmt_usd(trade['quote'])}  Mode: {trade['mode']}"]
            if trade.get("pnl") is not None:
                msg.append(f"Realized PnL: {fmt_usd(trade['pnl'])} ({trade.get('pnl_pct', 0):+.2f}%)")
            await self.telegram.broadcast("\n".join(msg))
        except Exception as e:
            log.exception("pending execution failed")
            await self._mark(pid, "failed", note=str(e)[:200])
            await self.telegram.broadcast(f"❌ <b>Order failed</b>: {e}")

    async def cancel_pending(self, pid: str, source: str):
        pend = self.state.get_pending(pid)
        if not pend or pend["status"] != "pending":
            return
        await self._mark(pid, "cancelled", note=f"cancelled via {source}")
        await self.telegram.broadcast(f"❌ Order {pend['side']} {pend['symbol']} cancelled (via {source}).")

    async def _mark(self, pid: str, status: str, **fields):
        await self.state.update_pending(pid, status=status, **fields)

    async def manual_trade(self, symbol: str, side: str):
        """Manual buy/sell from the dashboard — goes through the same
        confirmation flow (instant in dry-run)."""
        coin = self.state.snapshot()["coins"].get(symbol)
        if coin is None:
            raise BinanceError(f"{symbol} is not configured")
        price = await self.binance.ticker_price(symbol)
        target = coin["avg_cost"] * (1 + coin["sell_high_pct"] / 100) if side == "SELL" and coin["avg_cost"] else price
        news = await self._news([symbol])
        await self._handle_signal(symbol, side, price, target, news, source="manual")

    # -------------------------------------------------------------- telegram
    async def _telegram_loop(self):
        async def handle(update: dict):
            cb = update.get("callback_query")
            msg = update.get("message")
            if cb:
                chat_id = cb.get("message", {}).get("chat", {}).get("id")
                data = cb.get("data", "")
                await self.telegram.api("answerCallbackQuery", {"callback_query_id": cb["id"]})
                if not self.telegram.chat_allowed(chat_id):
                    log.warning("rejected callback from unauthorized chat %s", chat_id)
                    await self.telegram.send(chat_id, "⛔ Not authorized.")
                    return
                action, _, pid = data.partition(":")
                if action == "confirm":
                    await self.confirm_pending(pid, "telegram")
                elif action == "cancel":
                    await self.cancel_pending(pid, "telegram")
            elif msg:
                chat_id = msg.get("chat", {}).get("id")
                text = (msg.get("text") or "").strip()
                if not self.telegram.chat_allowed(chat_id):
                    log.warning("rejected message from unauthorized chat %s", chat_id)
                    await self.telegram.send(
                        chat_id,
                        f"⛔ This bot is private.\nYour chat id is <code>{chat_id}</code> — "
                        "add it to TELEGRAM_ALLOWED_CHAT_IDS in .env, then restart the app."
                    )
                    return
                await self._command(chat_id, text)

        await self.telegram.poll_loop(handle)

    async def _command(self, chat_id: int, text: str):
        cmd = text.split()[0].split("@")[0].lower() if text else ""
        if cmd in ("/start", "/help"):
            await self.telegram.send(chat_id, (
                "🤖 <b>AI Crypto Trader</b>\n"
                "/status — bot status\n"
                "/positions — open positions & PnL\n"
                "/trades — last 10 trades\n"
                "/pause — stop firing new signals\n"
                "/resume — resume the bot\n\n"
                f"Mode: {'🧪 DRY RUN' if settings.dry_run else '💰 LIVE'} · "
                "Every LIVE order needs your explicit Confirm."
            ))
        elif cmd == "/status":
            spent = await self.state.spend_today()
            coins = self.state.snapshot()["coins"]
            lines = [f"Bot: {'▶️ running' if self.running else '⏸ paused'}",
                     f"Mode: {'🧪 DRY RUN' if settings.dry_run else '💰 LIVE'}",
                     f"Coins: {', '.join(coins.keys()) or '—'}",
                     f"Spent today: {fmt_usd(spent)} / {fmt_usd(settings.max_daily_usdt)} cap"]
            await self.telegram.send(chat_id, "\n".join(lines))
        elif cmd == "/positions":
            snap = self.state.snapshot()
            lines = []
            for s, c in snap["coins"].items():
                if c["qty"] > 0:
                    try:
                        price = await self.binance.ticker_price(s)
                        pnl = (price - c["avg_cost"]) * c["qty"]
                        pct = (price / c["avg_cost"] - 1) * 100 if c["avg_cost"] else 0
                        lines.append(f"{s}: {c['qty']:.6f} @ avg {fmt_usd(c['avg_cost'])} → "
                                     f"{fmt_usd(price)} ({pct:+.2f}%, {fmt_usd(pnl)})")
                    except BinanceError:
                        lines.append(f"{s}: {c['qty']:.6f} (price unavailable)")
            await self.telegram.send(chat_id, "\n".join(lines) or "No open positions.")
        elif cmd == "/trades":
            trades = self.state.snapshot()["trades"][:10]
            lines = [f"{t['time'][5:16]} {t['side']} {t['symbol']} {t['qty']:.6f} @ "
                     f"{fmt_usd(t['price'])} [{t['mode']}]" for t in trades]
            await self.telegram.send(chat_id, "\n".join(lines) or "No trades yet.")
        elif cmd == "/pause":
            await self.stop_bot()
        elif cmd == "/resume":
            await self.start_bot()
        else:
            await self.telegram.send(chat_id, "Unknown command. Try /help")

    # ---------------------------------------------------------------- status
    async def get_status(self) -> dict:
        spent = await self.state.spend_today()
        return {
            "running": self.running,
            "started_at": self.started_at,
            "mode": "DRY RUN" if settings.dry_run else "LIVE",
            "dry_run": settings.dry_run,
            "testnet": settings.binance_testnet,
            "binance": {"configured": bool(settings.binance_api_key)},
            "telegram": {"configured": self.telegram.configured,
                         "allowed_chats": len(self.telegram.allowed)},
            "ai": {
                "llm_configured": bool(settings.ai_api_key) or has_ai_providers()
            },
            "coins_count": len(self.state.snapshot()["coins"]),
            "spent_today": spent,
            "max_daily_usdt": settings.max_daily_usdt,
            "max_order_usdt": settings.max_order_usdt,
            "server_time": now_iso(),
        }
