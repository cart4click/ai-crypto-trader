"""Order execution with hard safety rails.

Rails (always on, cannot be disabled from the UI):
- per-order cap      (MAX_ORDER_USDT)
- daily spend cap    (MAX_DAILY_USDT)
- Binance LOT_SIZE / minNotional compliance
- DRY_RUN mode simulates fills against real market prices
- NO withdrawal / transfer functionality exists anywhere in this app
"""
import datetime as dt
import logging
import uuid

from .binance_client import BinanceError, round_to_step
from .config import settings
from .state_store import StateStore

log = logging.getLogger("trader")


def _determine_decision_basis(meta: dict) -> str:
    """Determine if trade was based on AI signal or manual decision."""
    if not meta:
        return "unknown"
    
    source = meta.get("source", "")
    ai_decision = meta.get("ai", {}).get("decision", "")
    
    # Manual trades (user-initiated)
    if "manual" in source.lower():
        return "manual"
    
    # Bot trades with AI influence
    if "bot" in source.lower():
        if ai_decision == "wait":
            return "ai_overridden"  # AI said wait but user proceeded
        elif ai_decision == "proceed":
            return "ai_supported"  # AI agreed with the signal
        else:
            return "ai_neutral"  # No strong AI opinion
    
    # Telegram trades
    if "telegram" in source.lower():
        return "user_confirmed"  # User confirmed AI suggestion
    
    return "unknown"


class Trader:
    def __init__(self, binance, state: StateStore):
        self.b = binance
        self.state = state

    async def execute(self, symbol: str, side: str, usdt: float | None = None,
                      qty: float | None = None, meta: dict | None = None) -> dict:
        meta = meta or {}
        coin = self.state.snapshot()["coins"].get(symbol)
        if coin is None:
            raise BinanceError(f"{symbol} is not configured — add it first")
        filters = await self.b.exchange_filters(symbol)
        price = await self.b.ticker_price(symbol)
        now = dt.datetime.now().isoformat(timespec="seconds")

        if side == "BUY":
            spent = await self.state.spend_today()
            remaining = max(0.0, settings.max_daily_usdt - spent)
            if remaining <= 1:
                raise BinanceError(
                    f"Daily spend cap reached (${spent:.2f} of ${settings.max_daily_usdt:.2f})"
                )
            amount = min(usdt or coin["trade_amount_usdt"], settings.max_order_usdt, remaining)
            if amount < filters["minNotional"]:
                raise BinanceError(
                    f"Order ${amount:.2f} is below the Binance minimum notional "
                    f"(${filters['minNotional']:.2f})"
                )

            if settings.dry_run:
                fill_price = price
                ex_qty = amount / price
                ex_quote = amount
                raw = {"dry_run": True}
            else:
                raw = await self.b.market_buy_quote(symbol, amount)
                ex_quote = float(raw.get("cummulativeQuoteQty") or amount)
                ex_qty = float(raw.get("executedQty") or 0) or ex_quote / price
                fill_price = (ex_quote / ex_qty) if ex_qty > 0 else price

            await self.state.add_spend(ex_quote)

            def apply(d):
                c = d["coins"][symbol]
                old_qty, old_cost = c["qty"], c["avg_cost"]
                new_qty = old_qty + ex_qty
                c["avg_cost"] = (
                    ((old_cost * old_qty) + (fill_price * ex_qty)) / new_qty if new_qty > 0 else 0.0
                )
                c["qty"] = new_qty
                c["anchor_price"] = fill_price  # next dip is measured from this buy
                # Set position opened timestamp if this is the first position
                if old_qty == 0 and new_qty > 0:
                    c["position_opened"] = now
            await self.state.mutate(apply)

            trade = {
                "id": uuid.uuid4().hex[:10], "time": now, "symbol": symbol, "side": "BUY",
                "qty": ex_qty, "price": fill_price, "quote": ex_quote,
                "mode": "DRY RUN" if settings.dry_run else "LIVE", "status": "filled",
                "meta": meta,
                "decision_basis": _determine_decision_basis(meta),
            }
            await self.state.record_trade(trade)
            log.info("BUY %s %s qty=%.8f @ %.2f (%s)", symbol, trade["mode"], ex_qty, fill_price, meta.get("source", ""))
            return trade

        elif side == "SELL":
            position = coin["qty"]
            avg = coin["avg_cost"]
            sell_qty = min(qty if qty else position, position)
            sell_qty = round_to_step(sell_qty, filters["stepSize"])
            if position <= 0 or sell_qty <= 0 or sell_qty < filters["minQty"]:
                raise BinanceError("No position to sell (or amount below Binance min quantity)")
            if sell_qty * price < filters["minNotional"]:
                raise BinanceError(
                    f"Position value ${sell_qty * price:.2f} is below the Binance minimum "
                    f"notional (${filters['minNotional']:.2f})"
                )

            if settings.dry_run:
                fill_price = price
                ex_qty = sell_qty
                ex_quote = sell_qty * price
                raw = {"dry_run": True}
            else:
                raw = await self.b.market_sell_qty(symbol, sell_qty)
                ex_qty = float(raw.get("executedQty") or sell_qty)
                ex_quote = float(raw.get("cummulativeQuoteQty") or ex_qty * price)
                fill_price = (ex_quote / ex_qty) if ex_qty > 0 else price

            pnl = (fill_price - avg) * ex_qty if avg > 0 else 0.0
            pnl_pct = (fill_price / avg - 1.0) * 100 if avg > 0 else 0.0

            def apply(d):
                c = d["coins"][symbol]
                c["qty"] = round(c["qty"] - ex_qty, 12)
                if c["qty"] < filters["stepSize"]:
                    c["qty"] = 0.0
                    c["avg_cost"] = 0.0
                    c["position_opened"] = None  # Reset position opened timestamp
                c["anchor_price"] = fill_price  # wait for the next dip from here
            await self.state.mutate(apply)

            trade = {
                "id": uuid.uuid4().hex[:10], "time": now, "symbol": symbol, "side": "SELL",
                "qty": ex_qty, "price": fill_price, "quote": ex_quote,
                "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2),
                "mode": "DRY RUN" if settings.dry_run else "LIVE", "status": "filled",
                "meta": meta,
                "decision_basis": _determine_decision_basis(meta),
            }
            await self.state.record_trade(trade)
            log.info("SELL %s %s qty=%.8f @ %.2f pnl=%.2f", symbol, trade["mode"], ex_qty, fill_price, pnl)
            return trade

        raise BinanceError(f"Unknown side: {side}")
