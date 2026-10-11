"""AI Advisor — explicit BUY / SELL / HOLD recommendations from multiple factors.

Combines into one verdict:
- technicals (RSI, MACD, EMA20/50, Bollinger, volatility)
- Monte-Carlo 24h forecast (predicted low/high, median path)
- news sentiment (lexicon + optional LLM) and per-coin headlines
- Fear & Greed index

With AI_API_KEY set, an LLM weighs all factors and writes the reasoning.
Without a key, a transparent rule-based scorer produces the same structure.
Cached 10 minutes per symbol.
"""
import asyncio
import json
import logging
import re
import time

import httpx

from . import ai_provider, forecast
from .config import settings

log = logging.getLogger("advisor")

CACHE_TTL = 120  # 2 minutes for more responsive AI recommendations
_cache: dict[str, tuple[float, dict]] = {}

def get_provider_manager():
    return ai_provider.get_global_provider_manager()


async def get_advice(binance, news_provider, symbol: str) -> dict:
    now = time.time()
    hit = _cache.get(symbol)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]

    f = await forecast.get_forecast(binance, symbol)
    news = await news_provider([symbol])
    coin_news = news.get("coins", {}).get(symbol, {})
    ctx = _context(symbol, f, news, coin_news)

    # Check if we have any AI providers configured
    manager = get_provider_manager()
    has_providers = bool(manager.providers)
    
    if has_providers:
        try:
            advice = await _llm_advice(ctx)
        except Exception as e:
            log.warning("LLM advice failed (%s) — falling back to rule-based", e)
            advice = _rule_advice(ctx)
            advice["engine"] = "rules"
            advice["note"] = f"LLM unavailable ({str(e)[:80]}) — rule-based scoring"
    else:
        advice = _rule_advice(ctx)
        advice["engine"] = "rules"
    advice["context"] = ctx
    advice["generated_at"] = time.strftime("%Y-%m-%d %H:%M")
    _cache[symbol] = (now, advice)
    return advice


def _context(symbol: str, f: dict, news: dict, coin_news: dict) -> dict:
    ind = f["indicators"]
    headlines = [it["title"] for it in news.get("items", [])[:12]
                 if symbol in it.get("coins", [])][:6]
    if not headlines:
        headlines = [it["title"] for it in news.get("items", [])[:5]]
    return {
        "symbol": symbol,
        "price": round(f["last_close"], 2),
        "trend": f["trend"],
        "rsi14": round(ind["rsi"], 1),
        "macd_bullish": bool(ind["macd"] > ind["macd_signal"]),
        "ema20": round(ind["ema20"], 2),
        "ema50": round(ind["ema50"], 2),
        "bb_lower": round(ind["bb_lower"], 2),
        "bb_upper": round(ind["bb_upper"], 2),
        "predicted_24h_low": round(f["predicted_low"], 2),
        "predicted_24h_high": round(f["predicted_high"], 2),
        "median_24h": round(f["median_24h"], 2),
        "daily_volatility_pct": ind.get("daily_volatility_pct"),
        "news_label": coin_news.get("label"),
        "news_score": coin_news.get("score"),
        "news_ai_reason": coin_news.get("ai_reason"),
        "market_sentiment": news.get("market", {}).get("label"),
        "fear_greed": news.get("fear_greed"),
        "headlines": headlines,
    }


async def _llm_advice(ctx: dict) -> dict:
    system = (
        "You are a cautious crypto trading advisor. Weigh ALL the given factors "
        "(technicals, 24h Monte-Carlo forecast, news sentiment, Fear & Greed) and "
        "give ONE clear recommendation for the next 24 hours. Be conservative: "
        "when factors conflict, prefer HOLD. Respond with ONLY JSON: "
        '{"action": "BUY" | "SELL" | "HOLD", "confidence": <0.0..1.0>, '
        '"summary": "<3-4 sentences explaining the decision by referencing the factors>", '
        '"factors": [{"factor": "<name>", "view": "bullish|bearish|neutral", '
        '"detail": "<one short sentence>"} '
        "- include at least: Technicals, Forecast, News, Market mood]}"
    )
    
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(ctx, ensure_ascii=False)},
    ]
    
    try:
        provider_manager = get_provider_manager()
        result = await provider_manager.call_llm(
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"}
        )
        
        content = result["content"]
        d = json.loads(content)
        action = str(d.get("action", "HOLD")).upper()
        if action not in ("BUY", "SELL", "HOLD"):
            action = "HOLD"
        
        return {
            "action": action,
            "confidence": max(0.0, min(1.0, float(d.get("confidence", 0.5)))),
            "summary": str(d.get("summary", ""))[:600],
            "factors": (d.get("factors") or [])[:8],
            "engine": "llm",
            "provider": result["provider"],
            "model": result["model"],
            "response_time_ms": result["response_time_ms"]
        }
    except Exception as e:
        log.warning("Multi-provider LLM advice failed (%s) — falling back to rule-based", e)
        raise


def _rule_advice(ctx: dict) -> dict:
    s = 0.0
    factors = []

    trend_view = {"bullish": "bullish", "bearish": "bearish"}.get(ctx["trend"], "neutral")
    s += {"bullish": 1.0, "neutral": 0.0, "bearish": -1.0}[ctx["trend"]]
    factors.append({
        "factor": "Technicals", "view": trend_view,
        "detail": (f"EMA20 {'above' if ctx['ema20'] > ctx['ema50'] else 'below'} EMA50, "
                   f"MACD {'bullish' if ctx['macd_bullish'] else 'bearish'}, "
                   f"RSI {ctx['rsi14']}"),
    })

    if ctx["rsi14"] < 30:
        s += 1.0
        rview = "bullish (oversold)"
    elif ctx["rsi14"] > 70:
        s -= 1.0
        rview = "bearish (overbought)"
    else:
        rview = "neutral"
    factors.append({"factor": "RSI momentum", "view": rview, "detail": f"RSI14 = {ctx['rsi14']}"})

    upside = (ctx["median_24h"] / ctx["price"] - 1) * 100
    s += max(-1.0, min(1.0, upside / 3.0))
    factors.append({
        "factor": "Forecast", "view": "bullish" if upside > 0.5 else ("bearish" if upside < -0.5 else "neutral"),
        "detail": (f"median 24h {upside:+.1f}%, predicted range "
                   f"${ctx['predicted_24h_low']:,.0f}–${ctx['predicted_24h_high']:,.0f}"),
    })

    ns = ctx.get("news_score") or 0.0
    s += ns * 1.5
    factors.append({
        "factor": "News", "view": "bullish" if ns > 0.12 else ("bearish" if ns < -0.12 else "neutral"),
        "detail": ctx.get("news_ai_reason") or f"{ctx.get('news_label', 'Unknown')} on {ctx['symbol']}",
    })

    fg = ctx.get("fear_greed") or {}
    fgv = fg.get("value")
    if fgv is not None:
        if fgv <= 25:
            s += 0.5
            fgview = "bullish (fear = contrarian buy zone)"
        elif fgv >= 75:
            s -= 0.5
            fgview = "bearish (greed = euphoria risk)"
        else:
            fgview = "neutral"
        factors.append({"factor": "Market mood", "view": fgview,
                        "detail": f"Fear & Greed {fgv} ({fg.get('classification')})"})

    action = "BUY" if s > 0.7 else ("SELL" if s < -0.7 else "HOLD")
    conf = min(0.95, abs(s) / 2.5)
    summary = (
        f"{len(factors)} factors scored: combined {s:+.1f}. "
        f"Trend is {ctx['trend']}, RSI {ctx['rsi14']}, news {ctx.get('news_label', 'unknown')}, "
        f"median 24h forecast {upside:+.1f}%. → {action}"
    )
    return {"action": action, "confidence": round(conf, 2),
            "summary": summary, "factors": factors, "engine": "rules"}
