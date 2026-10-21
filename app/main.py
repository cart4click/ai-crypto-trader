
"""FastAPI backend + static dashboard protected by Supabase Auth."""
import asyncio
import datetime as dt
import logging
import re
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai_provider
from . import forecast
from .ai_provider import get_global_provider_manager
from .binance_client import BinanceError
from .config import settings
from .strategy import BotRunner
from .supabase_auth import get_authenticated_user

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
runner = BotRunner()
ai_manager = get_global_provider_manager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await runner.setup()
    # Perform AI provider health check
    await ai_manager.health_check()
    yield
    await runner.shutdown()
    await ai_manager.close()


# API documentation is intentionally disabled on the public deployment. Keep
# the schema private until an authenticated/admin documentation route exists.
app = FastAPI(
    title="AI Crypto Trader",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_RATE_WINDOW_SECONDS = 60
_API_REQUESTS_PER_WINDOW = 120
_CHAT_REQUESTS_PER_WINDOW = 20
_request_times: dict[str, deque[float]] = defaultdict(deque)


def _client_key(request: Request) -> str:
    """Use the direct peer address; do not trust spoofable forwarded headers."""
    return request.client.host if request.client else "unknown"


def _rate_limited(key: str, limit: int, now: float) -> bool:
    recent = _request_times[key]
    cutoff = now - _RATE_WINDOW_SECONDS
    while recent and recent[0] <= cutoff:
        recent.popleft()
    if len(recent) >= limit:
        return True
    recent.append(now)
    return False

if settings.app_cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.app_cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )


@app.middleware("http")
async def token_guard(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method != "OPTIONS":
        now = time.monotonic()
        client = _client_key(request)
        limit = _CHAT_REQUESTS_PER_WINDOW if request.url.path == "/api/chat" else _API_REQUESTS_PER_WINDOW
        if _rate_limited(f"api:{client}", limit, now):
            return JSONResponse(
                {"error": "Too many requests. Please try again later."},
                status_code=429,
                headers={"Retry-After": str(_RATE_WINDOW_SECONDS)},
            )
        try:
            request.state.user = await get_authenticated_user(request)
        except HTTPException as exc:
            return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: wss:; "
        "frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    if request.url.scheme == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(BinanceError)
async def binance_error_handler(request: Request, exc: BinanceError):
    return JSONResponse({"error": str(exc)}, status_code=400)


# --------------------------------------------------------------------- status
@app.get("/api/status")
async def status():
    status = await runner.get_status()
    # Add current AI provider info and all providers to the status
    if status.get("ai", {}).get("llm_configured"):
        status["ai"]["current_provider"] = ai_manager.get_current_provider_info()
        status["ai"]["all_providers"] = ai_manager.get_status()
    return status


# ---------------------------------------------------------------------- coins
@app.get("/api/coins")
async def coins():
    snap = runner.state.snapshot()

    async def enrich(symbol: str, c: dict):
        entry = dict(c)
        entry["symbol"] = symbol
        try:
            price = await runner.binance.ticker_price(symbol)
            t24 = await runner.binance.ticker_24h(symbol)
            entry["price"] = price
            entry["change_24h_pct"] = t24["change_pct"]
            entry["high_24h"] = t24["high"]
            entry["low_24h"] = t24["low"]
            entry["buy_target"] = (c["anchor_price"] * (1 - c["buy_dip_pct"] / 100)
                                   if c.get("anchor_price") else None)
            entry["sell_target"] = (c["avg_cost"] * (1 + c["sell_high_pct"] / 100)
                                    if c["qty"] > 0 and c["avg_cost"] > 0 else None)
            entry["position_value"] = c["qty"] * price if c["qty"] else 0.0
            entry["pnl"] = (price - c["avg_cost"]) * c["qty"] if c["qty"] else 0.0
            entry["pnl_pct"] = ((price / c["avg_cost"] - 1) * 100
                                if c["qty"] and c["avg_cost"] else None)
        except BinanceError as e:
            entry["error"] = str(e)
        return entry

    return await asyncio.gather(*(enrich(s, c) for s, c in snap["coins"].items()))


class CoinIn(BaseModel):
    symbol: str
    buy_dip_pct: float = 6.0
    sell_high_pct: float = 6.0
    trade_amount_usdt: float = 50.0


@app.post("/api/coins")
async def add_coin(body: CoinIn):
    symbol = body.symbol.strip().upper()
    if not symbol.endswith("USDT"):
        symbol += "USDT"
    if not symbol.replace("USDT", "").isalnum():
        raise HTTPException(400, "Invalid symbol")
    try:
        price = await runner.binance.ticker_price(symbol)
        await runner.binance.exchange_filters(symbol)
    except BinanceError as e:
        raise HTTPException(400, f"Symbol not found on Binance: {e}")
    existing = runner.state.snapshot()["coins"]
    if symbol in existing:
        raise HTTPException(400, f"{symbol} already added")
    await runner.state.add_coin(
        symbol, anchor_price=price, buy_dip_pct=body.buy_dip_pct,
        sell_high_pct=body.sell_high_pct, trade_amount_usdt=body.trade_amount_usdt,
    )
    return {"ok": True, "symbol": symbol, "anchor_price": price}


class CoinPatch(BaseModel):
    enabled: bool | None = None
    buy_dip_pct: float | None = None
    sell_high_pct: float | None = None
    trade_amount_usdt: float | None = None
    reset_anchor: bool = False
    qty: float | None = None
    avg_cost: float | None = None


@app.patch("/api/coins/{symbol}")
async def patch_coin(symbol: str, body: CoinPatch):
    symbol = symbol.strip().upper()
    if symbol not in runner.state.snapshot()["coins"]:
        raise HTTPException(404, f"{symbol} not configured")
    fields = {k: v for k, v in body.model_dump().items()
              if k not in ("reset_anchor",) and v is not None}
    if body.reset_anchor:
        fields["anchor_price"] = None  # re-anchors to current price on next tick
    await runner.state.update_coin(symbol, **fields)
    return {"ok": True}


@app.delete("/api/coins/{symbol}")
async def remove_coin(symbol: str):
    await runner.state.remove_coin(symbol.strip().upper())
    return {"ok": True}


# ----------------------------------------------------------------- AI / news
@app.get("/api/forecast/{symbol}")
async def get_forecast(symbol: str):
    try:
        return await forecast.get_forecast(runner.binance, symbol.strip().upper())
    except BinanceError as e:
        raise HTTPException(400, str(e))


@app.get("/api/news")
async def get_news(symbols: str | None = None):
    syms = ([s.strip().upper() for s in symbols.split(",")] if symbols
            else list(runner.state.snapshot()["coins"].keys()))
    return await runner._news(syms)


@app.get("/api/advice/{symbol}")
async def get_advice(symbol: str):
    from . import ai_advisor
    symbol = symbol.strip().upper()
    if symbol not in runner.state.snapshot()["coins"]:
        raise HTTPException(404, f"{symbol} not configured — add it first")
    return await ai_advisor.get_advice(runner.binance, runner._news, symbol)


@app.get("/api/ai-status")
async def get_ai_status():
    """Get status of all AI providers."""
    await ai_manager.health_check()
    return ai_manager.get_status()


@app.get("/api/whale")
async def get_whale_data(symbols: str | None = None):
    syms = ([s.strip().upper() for s in symbols.split(",")] if symbols
            else list(runner.state.snapshot()["coins"].keys()))
    whale_transactions = await runner.whale_monitor.fetch_whale_transactions(syms)
    whale_analysis = {}
    for symbol in syms:
        txs = whale_transactions.get(symbol, [])
        whale_analysis[symbol] = runner.whale_monitor.analyze_whale_sentiment(txs)
    
    # Include market-wide sentiment
    market_wide = runner.whale_monitor.calculate_market_wide_sentiment(whale_transactions)
    
    return {
        "coin_specific": whale_analysis,
        "market_wide": market_wide
    }


# --------------------------------------------------------- bot & confirmations
@app.post("/api/bot/start")
async def bot_start():
    await runner.start_bot()
    return {"ok": True, "running": True}


@app.post("/api/bot/stop")
async def bot_stop():
    await runner.stop_bot()
    return {"ok": True, "running": False}


@app.get("/api/pending")
async def pending():
    return runner.state.pending_list()


@app.post("/api/pending/{pid}/confirm")
async def confirm(pid: str):
    await runner.confirm_pending(pid, "web")
    return {"ok": True}


@app.post("/api/pending/{pid}/cancel")
async def cancel(pid: str):
    await runner.cancel_pending(pid, "web")
    return {"ok": True}

@app.delete("/api/pending")
async def clear_pending():
    """Clear all pending confirmations."""
    await runner.state.clear_pending()
    return {"ok": True}


class ManualTrade(BaseModel):
    symbol: str
    side: str  # BUY | SELL


@app.post("/api/manual-trade")
async def manual_trade(body: ManualTrade):
    side = body.side.strip().upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    await runner.manual_trade(body.symbol.strip().upper(), side)
    return {"ok": True}


# --------------------------------------------------------------- account data
@app.get("/api/balances")
async def balances():
    return await runner.binance.balances()

@app.get("/api/wallet")
async def wallet():
    """Get comprehensive wallet information using live Binance data for configured coins only."""
    import logging
    import datetime as dt
    log = logging.getLogger(__name__)
    
    try:
        balances = await runner.binance.balances()
        spent_today = await runner.state.spend_today()
        snapshot = runner.state.snapshot()
        coins = snapshot.get("coins", {})
        
        # Calculate USDT balance from live Binance
        usdt_balance = 0.0
        for bal in balances:
            if bal["asset"] == "USDT":
                usdt_balance = float(bal["free"]) + float(bal["locked"])
                break
        
        # Calculate positions value for configured coins only
        total_wallet_value = usdt_balance
        positions = []
        
        for symbol, coin_data in coins.items():
            if not coin_data.get("enabled", False):
                continue
                
            qty = coin_data.get("qty", 0)
            if qty > 0:
                # Get current price from binance
                try:
                    current_price = await runner.binance.ticker_price(symbol)
                    position_value = qty * current_price
                    total_wallet_value += position_value
                    avg_cost = coin_data.get("avg_cost", 0)
                    invested = qty * avg_cost
                    pnl = position_value - invested
                    pnl_pct = (pnl / invested * 100) if invested > 0 else 0
                    
                    positions.append({
                        "symbol": symbol,
                        "qty": qty,
                        "current_price": current_price,
                        "avg_cost": avg_cost,
                        "position_value": position_value,
                        "invested": invested,
                        "pnl": pnl,
                        "pnl_pct": pnl_pct,
                        "position_opened": coin_data.get("position_opened")
                    })
                except Exception as e:
                    log.warning(f"Failed to get price for {symbol}: {e}")
        
        total_invested = sum(pos["invested"] for pos in positions)
        
        return {
            "usdt_balance": usdt_balance,
            "positions_value": total_wallet_value - usdt_balance,
            "total_wallet_value": total_wallet_value,
            "total_invested": total_invested,
            "total_pnl": sum(pos["pnl"] for pos in positions),
            "positions": positions,
            "spent_today": spent_today,
            "max_daily_usdt": settings.max_daily_usdt,
            "last_updated": dt.datetime.now().isoformat()
        }
    except Exception as e:
        log.exception("Failed to get wallet info")
        return {"error": str(e)}


@app.get("/api/trades")
async def trades():
    return runner.state.snapshot()["trades"][:50]


@app.get("/api/report")
async def generate_report():
    """Generate detailed trading report with AI decision analysis."""
    snapshot = runner.state.snapshot()
    trades = snapshot["trades"]
    pending = snapshot["pending"]
    coins = snapshot["coins"]
    
    # Analyze decision patterns
    decision_basis_counts = {}
    ai_influence_stats = {
        "ai_supported": 0,
        "ai_overridden": 0, 
        "manual": 0,
        "user_confirmed": 0,
        "ai_neutral": 0,
        "unknown": 0
    }
    
    for trade in trades:
        basis = trade.get("decision_basis", "unknown")
        decision_basis_counts[basis] = decision_basis_counts.get(basis, 0) + 1
        if basis in ai_influence_stats:
            ai_influence_stats[basis] += 1
    
    # Calculate performance by decision basis
    performance_by_basis = {}
    for basis in decision_basis_counts.keys():
        basis_trades = [t for t in trades if t.get("decision_basis") == basis]
        total_pnl = sum(t.get("pnl", 0) for t in basis_trades)
        win_rate = len([t for t in basis_trades if t.get("pnl", 0) > 0]) / len(basis_trades) if basis_trades else 0
        performance_by_basis[basis] = {
            "total_trades": len(basis_trades),
            "total_pnl": round(total_pnl, 2),
            "win_rate": round(win_rate * 100, 1)
        }
    
    return {
        "summary": {
            "total_trades": len(trades),
            "decision_basis_breakdown": decision_basis_counts,
            "ai_influence_stats": ai_influence_stats,
            "performance_by_basis": performance_by_basis
        },
        "recent_trades": trades[:10],
        "pending_signals": [p for p in pending.values() if p["status"] == "pending"],
        "active_positions": {
            symbol: {
                "qty": coin["qty"],
                "avg_cost": coin["avg_cost"],
                "current_value": coin.get("position_value", 0),
                "pnl": coin.get("pnl", 0)
            }
            for symbol, coin in coins.items() if coin["qty"] > 0
        }
    }


@app.post("/api/chat")
async def chat(request: Request):
    """AI chat assistant for trading reports and commands."""
    import logging
    log = logging.getLogger(__name__)
    
    try:
        body = await request.json()
        user_message = body.get("message", "").strip()
        if len(user_message) > 4000:
            return JSONResponse({"error": "Message is too long."}, status_code=413)
        chat_history = body.get("history", [])
        if not isinstance(chat_history, list):
            chat_history = []
        chat_history = [
            {"role": item.get("role"), "content": str(item.get("content", ""))[:2000]}
            for item in chat_history[-12:]
            if isinstance(item, dict)
            and item.get("role") in ("user", "assistant")
            and str(item.get("content", "")).strip()
        ]
        
        if not user_message:
            return {"response": "Please provide a message."}
        
        # Get current system status
        status = await runner.get_status()
        try:
            wallet_data = await runner.binance.balances()
        except BinanceError:
            wallet_data = []
        trades = runner.state.snapshot().get("trades", [])
        coins = runner.state.snapshot().get("coins", {})
        live_market = await get_live_market_snapshot(list(coins.keys()))
        
        # Build context for AI
        context = {
            "status": status,
            "wallet_balance": sum(float(b["free"]) + float(b["locked"]) for b in wallet_data if b["asset"] == "USDT"),
            "trades_count": len(trades),
            "coins": list(coins.keys()),
            "bot_running": status.get("running", False),
            "mode": status.get("mode", "UNKNOWN"),
            "testnet": status.get("testnet", False),
            "live_market": live_market,
            "live_market_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }
        
        # Process common commands
        user_message_lower = user_message.lower()
        
        # Check for explicit trading commands (must start with buy/sell and have specific structure)
        is_buy_command = user_message_lower.startswith("buy ") or (user_message_lower == "buy")
        is_sell_command = user_message_lower.startswith("sell ") or (user_message_lower == "sell")
        price_response = get_live_price_response(user_message, live_market, context["live_market_at"])
        
        # Report commands
        if price_response:
            response = price_response
        elif "report" in user_message_lower or "status" in user_message_lower:
            response = generate_status_report(context, trades, coins)
        elif "balance" in user_message_lower or "wallet" in user_message_lower:
            response = generate_wallet_report(context, wallet_data, coins)
        elif is_buy_command:
            response = handle_buy_command(user_message_lower, context)
        elif is_sell_command:
            response = handle_sell_command(user_message_lower, context)
        elif "help" in user_message_lower:
            response = generate_help_message()
        else:
            # Use AI for general questions (including "should I buy/sell?" type questions)
            response = await get_ai_chat_response(user_message, context, chat_history)
        
        return {"response": response}
        
    except Exception as e:
        log.exception("Chat processing failed")
        return {"response": f"Sorry, I encountered an error: {str(e)}"}

def generate_status_report(context, trades, coins):
    """Generate a comprehensive status report."""
    pnl = sum(t.get("pnl", 0) for t in trades)
    pnl_sign = "+" if pnl >= 0 else ""
    
    return (
        f"📊 **Trading Bot Status Report**\n\n"
        f"**Bot Status**: {'🟢 Running' if context['bot_running'] else '🔴 Paused'}\n"
        f"**Mode**: {context['mode']} (Testnet: {context['testnet']})\n"
        f"**USDT Balance**: ${context['wallet_balance']:,.2f}\n"
        f"**Active Coins**: {', '.join(context['coins']) or 'None'}\n"
        f"**Total Trades**: {context['trades_count']}\n"
        f"**Total P&L**: {pnl_sign}{pnl:.2f} USDT\n\n"
        f"The bot is actively monitoring the markets and will generate trading signals based on AI analysis."
    )

def generate_wallet_report(context, wallet_data, coins):
    """Generate wallet balance report."""
    usdt_balance = sum(float(b["free"]) + float(b["locked"]) for b in wallet_data if b["asset"] == "USDT")
    
    positions = []
    for symbol, coin_data in coins.items():
        if coin_data.get("enabled", False) and coin_data.get("qty", 0) > 0:
            positions.append(f"{symbol}: {coin_data['qty']:.6f} @ ${coin_data['avg_cost']:.2f}")
    
    return (
        f"💰 **Wallet Report**\n\n"
        f"**USDT Balance**: ${usdt_balance:,.2f}\n"
        f"**Positions**:\n" + "\n".join(positions) if positions else "No open positions\n"
    )

def handle_buy_command(message, context):
    """Handle buy commands."""
    if not context['bot_running']:
        return "⚠️ The bot is currently paused. Please start the bot first."
    
    # Extract coin symbol from message
    words = message.split()
    coin = None
    for word in words:
        if word.upper().endswith("USDT") or word.upper() in ["BTC", "ETH", "SOL", "BNB"]:
            coin = word.upper()
            break
    
    if coin:
        return f"🤖 Buy command received for {coin}. The bot will analyze market conditions and generate a trading signal. Please check the 'Pending Confirmations' section for approval."
    else:
        return "❓ Please specify which coin to buy (e.g., 'buy SOL' or 'buy SOLUSDT')."

def handle_sell_command(message, context):
    """Handle sell commands."""
    if not context['bot_running']:
        return "⚠️ The bot is currently paused. Please start the bot first."
    
    # Parse sell amount
    if "half" in message or "50%" in message:
        return "🤖 Sell half command received. The bot will analyze current positions and generate a sell signal for 50% of your holdings. Please check 'Pending Confirmations' for approval."
    elif "all" in message:
        return "🤖 Sell all command received. The bot will analyze current positions and generate a sell signal for all holdings. Please check 'Pending Confirmations' for approval."
    else:
        return "🤖 Sell command received. The bot will analyze current positions and generate a sell signal. Please check 'Pending Confirmations' for approval."

def generate_help_message():
    """Generate help message with available commands."""
    return (
        "🤖 **AI Trading Assistant Help**\n\n"
        "**Available Commands:**\n"
        "• `report` or `status` - Get trading bot status report\n"
        "• `balance` or `wallet` - Get wallet balance report\n"
        "• `buy [coin]` - Request to buy a coin (e.g., 'buy SOL')\n"
        "• `sell [amount]` - Request to sell (e.g., 'sell half', 'sell all')\n"
        "• `help` - Show this help message\n\n"
        "**Questions you can ask:**\n"
        "• 'How is the market doing?'\n"
        "• 'What's my current P&L?'\n"
        "• 'Should I buy or sell now?'\n"
        "• 'Explain the latest AI recommendation'\n\n"
        "All trades require your confirmation before execution!"
    )


def get_live_price_response(message: str, live_market: list[dict], fetched_at: str) -> str | None:
    """Answer explicit current-price questions from Binance data, not the LLM."""
    lowered = message.lower()
    if not re.search(r"\b(price|cost|trading|worth)\b", lowered):
        return None

    for market in live_market:
        base = market["symbol"].removesuffix("USDT").lower()
        if re.search(rf"\b{re.escape(base)}(?:usdt)?\b", lowered):
            return (
                f"The current {base.upper()}/USDT price is "
                f"${market['price']:,.2f} (Binance public ticker, fetched {fetched_at})."
            )
    return None

async def get_ai_chat_response(user_message, context, chat_history=None):
    """Get AI response for general questions using the configured AI provider."""
    try:
        provider_manager = ai_provider.get_global_provider_manager()
        
        # Get current market data for context
        snapshot = runner.state.snapshot()
        coins = snapshot.get("coins", {})
        
        # Build detailed context for AI
        market_context = {
            "bot_status": "Running" if context['bot_running'] else "Paused",
            "mode": context['mode'],
            "testnet": context['testnet'],
            "wallet_balance": context['wallet_balance'],
            "active_coins": context['coins'],
            "total_trades": context['trades_count'],
            "live_market": context.get("live_market", []),
            "positions": [
                {
                    "symbol": symbol,
                    "qty": coin['qty'],
                    "avg_cost": coin['avg_cost'],
                    "current_value": coin.get('position_value', 0)
                }
                for symbol, coin in coins.items() 
                if coin.get('enabled', False) and coin.get('qty', 0) > 0
            ]
        }
        
        system_prompt = (
            "You are an intelligent AI trading assistant for a cryptocurrency trading bot. "
            "You have access to a timestamped live market snapshot, trading performance, and bot status. "
            "Provide helpful, accurate, and concise responses about trading, market conditions, "
            "and the bot's operations. Be conversational and helpful. "
            "Use the supplied live market snapshot for current prices and 24h changes, and mention "
            "when its timestamp matters. Never invent prices or claim a market condition that is not "
            "supported by the snapshot. The bot is currently running in testnet mode for safety testing. "
            "Always provide specific, actionable advice when asked about trading decisions."
        )
        
        user_prompt = (
            f"User question: {user_message}\n\n"
            f"Current Context:\n"
            f"- Bot Status: {market_context['bot_status']}\n"
            f"- Trading Mode: {market_context['mode']} (Testnet: {market_context['testnet']})\n"
            f"- Wallet Balance: ${market_context['wallet_balance']:,.2f}\n"
            f"- Active Coins: {', '.join(market_context['active_coins']) if market_context['active_coins'] else 'None'}\n"
            f"- Total Trades: {market_context['total_trades']}\n"
            f"- Current Positions: {len(market_context['positions'])} open positions\n"
        )

        if market_context['live_market']:
            user_prompt += "\nLive market snapshot (fetched for this message):\n"
            for market in market_context['live_market']:
                user_prompt += (
                    f"- {market['symbol']}: ${market['price']:,.8f} "
                    f"({market['change_24h_pct']:+.2f}% 24h), "
                    f"24h range ${market['low_24h']:,.8f}-${market['high_24h']:,.8f}\n"
                )
            user_prompt += f"- Snapshot time: {context.get('live_market_at', 'just now')}\n"
        
        if market_context['positions']:
            user_prompt += "\nPosition Details:\n"
            for pos in market_context['positions']:
                user_prompt += f"- {pos['symbol']}: {pos['qty']:.6f} @ ${pos['avg_cost']:.2f} (Value: ${pos['current_value']:.2f})\n"
        
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(chat_history or [])
        messages.append({"role": "user", "content": user_prompt})
        
        result = await provider_manager.call_llm(
            messages=messages,
            temperature=0.2,
            response_format={"type": "text"}
        )
        
        return result["content"][:600]  # Limit response length for readability
        
    except Exception as e:
        logging.getLogger(__name__).warning(f"AI chat failed: {e}")
        return "I'm having trouble connecting to my AI provider right now. Please try again or use specific commands like 'report' or 'balance'."


async def get_live_market_snapshot(symbols: list[str]) -> list[dict]:
    """Fetch current public market data for chat without requiring Binance keys."""
    requested = list(dict.fromkeys(symbols + ["BTCUSDT", "ETHUSDT", "SOLUSDT"]))

    async def fetch(symbol: str) -> dict | None:
        try:
            ticker = await runner.binance.ticker_24h(symbol)
            return {
                "symbol": symbol,
                "price": ticker["last_price"],
                "change_24h_pct": ticker["change_pct"],
                "high_24h": ticker["high"],
                "low_24h": ticker["low"],
            }
        except BinanceError as exc:
            logging.getLogger(__name__).warning("Live chat market data failed for %s: %s", symbol, exc)
            return None

    return [market for market in await asyncio.gather(*(fetch(symbol) for symbol in requested)) if market]


# -------------------------------------------------------------------- static
@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="static")
