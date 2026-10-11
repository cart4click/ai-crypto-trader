"""AI price forecast — self-contained, no external AI key required.

Method: bootstrap Monte-Carlo simulation over recent hourly returns.
1. Take ~2 weeks of 1h log-returns from Binance.
2. Add a damped trend drift (mean of the last 7 days of returns).
3. Simulate 2000 random 24-hour paths by resampling those returns.
4. From the simulated distribution derive:
   - predicted 24h low  (5th percentile of each path's minimum)
   - predicted 24h high (95th percentile of each path's maximum)
   - median path + 5-95% confidence band for the chart
   - P(price dips below X / rises above Y within 24h) — used by the
     strategy engine for the "AI expects a deeper dip / higher high" override.

Optionally an LLM (AI_API_KEY) adds a narrative summary on top — see news.py.
"""
import logging
import time

import numpy as np

from . import indicators

log = logging.getLogger("forecast")

HORIZON_HOURS = 24
N_SIMS = 2000
CACHE_TTL = 300  # seconds

_cache: dict[str, tuple[float, dict]] = {}
_mats: dict[str, tuple[float, np.ndarray]] = {}


async def get_forecast(binance, symbol: str) -> dict:
    now = time.time()
    hit = _cache.get(symbol)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]

    klines = await binance.klines(symbol, "1h", 500)
    if len(klines) < 60:
        raise RuntimeError(f"Not enough history for {symbol}")
    closes = np.array([k["close"] for k in klines], dtype=float)
    highs = np.array([k["high"] for k in klines], dtype=float)
    lows = np.array([k["low"] for k in klines], dtype=float)
    last_ms = klines[-1]["open_time"]
    interval_ms = (klines[1]["open_time"] - klines[0]["open_time"]) if len(klines) > 1 else 3_600_000

    last_close = float(closes[-1])
    rets = np.diff(np.log(closes))
    pool = rets[-336:]  # ~2 weeks of hourly returns
    drift = float(np.mean(rets[-168:])) * 0.5 if len(rets) >= 168 else float(np.mean(pool)) * 0.5

    rng = np.random.default_rng()
    sample = rng.choice(pool, size=(N_SIMS, HORIZON_HOURS), replace=True)
    sim = last_close * np.exp(np.cumsum(sample + drift, axis=1))
    full = np.hstack([np.full((N_SIMS, 1), last_close), sim])  # include t0 column

    ind = indicators.compute_all(closes, highs, lows)
    score = 0.0
    score += 1.0 if ind["ema20"] > ind["ema50"] else -1.0
    score += 0.5 if last_close > ind["ema20"] else -0.5
    score += 0.5 if ind["macd"] > ind["macd_signal"] else -0.5
    trend = "bullish" if score >= 1.0 else ("bearish" if score <= -1.0 else "neutral")

    mins = full.min(axis=1)
    maxs = full.max(axis=1)
    result = {
        "symbol": symbol,
        "last_close": last_close,
        "horizon_hours": HORIZON_HOURS,
        "history_times": [k["open_time"] for k in klines[-168:]],
        "history_closes": closes[-168:].tolist(),
        "forecast_times": [last_ms + interval_ms * (i + 1) for i in range(HORIZON_HOURS)],
        "median_path": np.median(full, axis=0)[1:].tolist(),
        "band_low": np.percentile(full, 5, axis=0)[1:].tolist(),
        "band_high": np.percentile(full, 95, axis=0)[1:].tolist(),
        "predicted_low": float(np.percentile(mins, 5)),
        "predicted_high": float(np.percentile(maxs, 95)),
        "median_24h": float(np.median(full[:, -1])),
        "trend": trend,
        "trend_score": float(score),
        "indicators": ind,
    }
    _cache[symbol] = (now, result)
    _mats[symbol] = (now, full)
    return result


async def probs_for(binance, symbol: str, targets: dict[str, tuple[float, str]]) -> dict[str, float]:
    """Probability of hitting price levels within the horizon.

    targets: name -> (price, kind). kind "below" -> P(path minimum <= price),
    kind "above" -> P(path maximum >= price).
    """
    await get_forecast(binance, symbol)  # refresh if stale
    ent = _mats.get(symbol)
    if not ent:
        return {}
    full = ent[1]
    out: dict[str, float] = {}
    for name, (price, kind) in targets.items():
        if kind == "below":
            out[name] = float((full.min(axis=1) <= price).mean())
        else:
            out[name] = float((full.max(axis=1) >= price).mean())
    return out
