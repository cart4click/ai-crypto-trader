"""Binance Spot REST wrapper.

SECURITY NOTE: this client intentionally implements ONLY market-data and
spot-order endpoints. There are no withdrawal / transfer / deposit calls
anywhere in this codebase. Combined with an API key created without
withdrawal permission (see README), funds can never leave the exchange
through this app.
"""
import hashlib
import hmac
import logging
import math
import time
from urllib.parse import urlencode

import httpx

from .config import settings

log = logging.getLogger("binance")

# Market data always comes from the public API (works without keys, better data
# quality than the testnet). Only TRADING requests go to testnet or live.
MARKET_DATA_URL = "https://api.binance.com"


class BinanceError(RuntimeError):
    pass


def round_to_step(value: float, step: float) -> float:
    """Round a quantity DOWN to the symbol's LOT_SIZE step."""
    if step <= 0:
        return value
    return round(math.floor(value / step + 1e-9) * step, 10)


class BinanceClient:
    def __init__(self):
        self.trade_base = (
            "https://testnet.binance.vision" if settings.binance_testnet else "https://api.binance.com"
        )
        self._md = httpx.AsyncClient(base_url=MARKET_DATA_URL, timeout=20)
        self._td = httpx.AsyncClient(base_url=self.trade_base, timeout=20)
        self._time_offset = 0
        self._filters: dict[str, tuple[float, dict]] = {}

    async def close(self):
        await self._md.aclose()
        await self._td.aclose()

    # ------------------------------------------------------------------ core
    async def _resync_time(self):
        r = await self._td.get("/api/v3/time")
        r.raise_for_status()
        self._time_offset = r.json()["serverTime"] - int(time.time() * 1000)
        log.info("Binance server time offset: %d ms", self._time_offset)

    def _signed_qs(self, params: dict) -> str:
        params = dict(params)
        params["timestamp"] = int(time.time() * 1000) + self._time_offset
        params.setdefault("recvWindow", 5000)
        qs = urlencode(params, doseq=True)
        sig = hmac.new(settings.binance_api_secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
        return f"{qs}&signature={sig}"

    @staticmethod
    def _json(r: httpx.Response):
        try:
            return r.json()
        except Exception:
            return {"raw": r.text}

    async def _request(self, client, method: str, path: str, params: dict | None = None,
                       signed: bool = False, retries: int = 1):
        headers = {}
        if signed:
            if not settings.binance_api_key or not settings.binance_api_secret:
                raise BinanceError(
                    "Binance API keys not configured — set BINANCE_API_KEY / BINANCE_API_SECRET in .env"
                )
            headers["X-MBX-APIKEY"] = settings.binance_api_key
        params = params or {}
        if signed:
            url = f"{path}?{self._signed_qs(params)}"
            r = await client.request(method, url, headers=headers)
            data = self._json(r)
            # clock skew -> resync once and retry
            if isinstance(data, dict) and data.get("code") == -1021 and retries > 0:
                await self._resync_time()
                return await self._request(client, method, path, params, signed, retries - 1)
        else:
            r = await client.request(method, path, params=params, headers=headers)
            data = self._json(r)
        if r.status_code >= 400:
            msg = data.get("msg") if isinstance(data, dict) else r.text
            raise BinanceError(f"Binance {method} {path} failed ({r.status_code}): {msg}")
        return data

    # ----------------------------------------------------------- market data
    async def klines(self, symbol: str, interval: str = "1h", limit: int = 500) -> list[dict]:
        data = await self._request(
            self._md, "GET", "/api/v3/klines",
            {"symbol": symbol, "interval": interval, "limit": limit},
        )
        return [
            {
                "open_time": int(k[0]),
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5]),
                "close_time": int(k[6]),
            }
            for k in data
        ]

    async def ticker_price(self, symbol: str) -> float:
        d = await self._request(self._md, "GET", "/api/v3/ticker/price", {"symbol": symbol})
        return float(d["price"])

    async def ticker_24h(self, symbol: str) -> dict:
        d = await self._request(self._md, "GET", "/api/v3/ticker/24hr", {"symbol": symbol})
        return {
            "last_price": float(d["lastPrice"]),
            "change_pct": float(d["priceChangePercent"]),
            "high": float(d["highPrice"]),
            "low": float(d["lowPrice"]),
            "quote_volume": float(d["quoteVolume"]),
        }

    async def exchange_filters(self, symbol: str) -> dict:
        now = time.time()
        cached = self._filters.get(symbol)
        if cached and now - cached[0] < 86400:
            return cached[1]
        d = await self._request(self._md, "GET", "/api/v3/exchangeInfo", {"symbol": symbol})
        s = d["symbols"][0]
        f = {flt["filterType"]: flt for flt in s["filters"]}
        info = {
            "stepSize": float(f.get("LOT_SIZE", {}).get("stepSize", "0.00001")),
            "tickSize": float(f.get("PRICE_FILTER", {}).get("tickSize", "0.01")),
            "minQty": float(f.get("LOT_SIZE", {}).get("minQty", "0")),
            "minNotional": float(
                f.get("NOTIONAL", {}).get("minNotional")
                or f.get("MIN_NOTIONAL", {}).get("minNotional", "5")
            ),
        }
        self._filters[symbol] = (now, info)
        return info

    # ------------------------------------------------------ trading (signed)
    async def account(self) -> dict:
        return await self._request(self._td, "GET", "/api/v3/account", signed=True)

    async def balances(self) -> list[dict]:
        d = await self.account()
        return [
            {"asset": b["asset"], "free": float(b["free"]), "locked": float(b["locked"])}
            for b in d["balances"]
            if float(b["free"]) + float(b["locked"]) > 0
        ]

    async def my_trades(self, symbol: str, limit: int = 25) -> list[dict]:
        return await self._request(self._td, "GET", "/api/v3/myTrades",
                                   {"symbol": symbol, "limit": limit}, signed=True)

    async def market_buy_quote(self, symbol: str, quote_qty: float) -> dict:
        """Market buy spending `quote_qty` USDT."""
        return await self._request(
            self._td, "POST", "/api/v3/order",
            {"symbol": symbol, "side": "BUY", "type": "MARKET",
             "quoteOrderQty": f"{quote_qty:.8f}"},
            signed=True,
        )

    async def market_sell_qty(self, symbol: str, quantity: float) -> dict:
        """Market sell of `quantity` base asset."""
        return await self._request(
            self._td, "POST", "/api/v3/order",
            {"symbol": symbol, "side": "SELL", "type": "MARKET",
             "quantity": f"{quantity:.8f}"},
            signed=True,
        )
