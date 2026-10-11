"""JSON-file persistence for coins, trades, pending confirmations and spend."""
import asyncio
import copy
import datetime as dt
import json
import os

EMPTY = {"coins": {}, "trades": [], "pending": {}, "spend": {"date": "", "usdt": 0.0}}

DEFAULT_COIN = {
    "enabled": True,
    "buy_dip_pct": 6.0,
    "sell_high_pct": 6.0,
    "trade_amount_usdt": 50.0,
    "anchor_price": None,   # dip % is measured from this price
    "qty": 0.0,
    "avg_cost": 0.0,
    "position_opened": None,  # timestamp when position was opened
}


class StateStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = asyncio.Lock()
        self.data = copy.deepcopy(EMPTY)

    def _today(self) -> str:
        return dt.date.today().isoformat()

    async def load(self):
        async with self._lock:
            if os.path.exists(self.path):
                try:
                    with open(self.path) as f:
                        stored = json.load(f)
                    self.data.update(stored)
                except Exception:
                    # corrupted state: start fresh but keep the old file
                    os.replace(self.path, self.path + ".corrupt")

    async def _save_locked(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=2, default=str)
        os.replace(tmp, self.path)

    async def mutate(self, fn):
        """Run fn(data) under the lock and persist afterwards."""
        async with self._lock:
            fn(self.data)
            await self._save_locked()

    def snapshot(self) -> dict:
        return copy.deepcopy(self.data)

    # ------------------------------------------------------------- spend cap
    async def add_spend(self, amount: float) -> float:
        async with self._lock:
            if self.data["spend"].get("date") != self._today():
                self.data["spend"] = {"date": self._today(), "usdt": 0.0}
            self.data["spend"]["usdt"] = round(self.data["spend"]["usdt"] + amount, 2)
            total = self.data["spend"]["usdt"]
            await self._save_locked()
            return total

    async def spend_today(self) -> float:
        async with self._lock:
            if self.data["spend"].get("date") != self._today():
                return 0.0
            return float(self.data["spend"].get("usdt", 0.0))

    # ----------------------------------------------------------------- coins
    async def add_coin(self, symbol: str, **overrides) -> dict:
        coin = copy.deepcopy(DEFAULT_COIN)
        coin.update(overrides)
        await self.mutate(lambda d: d["coins"].__setitem__(symbol, coin))
        return coin

    async def update_coin(self, symbol: str, **fields):
        def fn(d):
            if symbol in d["coins"]:
                d["coins"][symbol].update(fields)
        await self.mutate(fn)

    async def remove_coin(self, symbol: str):
        await self.mutate(lambda d: d["coins"].pop(symbol, None))

    # ---------------------------------------------------------------- trades
    async def record_trade(self, trade: dict):
        def fn(d):
            d["trades"].insert(0, trade)
            del d["trades"][200:]
        await self.mutate(fn)

    # --------------------------------------------------------------- pending
    async def add_pending(self, pend: dict):
        await self.mutate(lambda d: d["pending"].__setitem__(pend["id"], pend))

    async def update_pending(self, pid: str, **fields):
        def fn(d):
            if pid in d["pending"]:
                d["pending"][pid].update(fields)
        await self.mutate(fn)

    async def clear_pending(self):
        """Clear all pending confirmations."""
        await self.mutate(lambda d: d.update({"pending": {}}))

    def get_pending(self, pid: str) -> dict | None:
        return copy.deepcopy(self.data["pending"].get(pid))

    def pending_list(self) -> list[dict]:
        return sorted(self.snapshot()["pending"].values(), key=lambda p: p["created_at"], reverse=True)
