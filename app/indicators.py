"""Technical indicators computed with pandas (no external binary deps)."""
import numpy as np
import pandas as pd


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    return (100.0 - 100.0 / (1.0 + rs)).fillna(50.0)


def macd(close: pd.Series):
    line = ema(close, 12) - ema(close, 26)
    signal = ema(line, 9)
    return line, signal, line - signal


def bollinger(close: pd.Series, period: int = 20, k: float = 2.0):
    mid = close.rolling(period).mean()
    sd = close.rolling(period).std(ddof=0)
    return mid + k * sd, mid, mid - k * sd


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False).mean()


def compute_all(closes, highs, lows) -> dict:
    close = pd.Series(closes, dtype=float)
    high = pd.Series(highs, dtype=float)
    low = pd.Series(lows, dtype=float)
    m_line, m_signal, m_hist = macd(close)
    bb_u, _, bb_l = bollinger(close)
    a = atr(high, low, close)
    rets = np.diff(np.log(close.values))
    return {
        "rsi": float(rsi(close).iloc[-1]),
        "macd": float(m_line.iloc[-1]),
        "macd_signal": float(m_signal.iloc[-1]),
        "macd_hist": float(m_hist.iloc[-1]),
        "ema20": float(ema(close, 20).iloc[-1]),
        "ema50": float(ema(close, 50).iloc[-1]),
        "bb_upper": float(bb_u.iloc[-1]),
        "bb_lower": float(bb_l.iloc[-1]),
        "atr": float(a.iloc[-1]),
        "daily_volatility_pct": (
            float(np.nanstd(rets[-168:]) * np.sqrt(24) * 100) if len(rets) >= 24 else None
        ),
    }
