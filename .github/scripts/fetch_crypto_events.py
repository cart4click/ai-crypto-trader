"""Build a public, key-free snapshot from CoinMarketCal for GitHub Pages."""
import datetime as dt
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


OUTPUT = Path("frontend/events.json")
API_URL = "https://api.coinmarketcal.com/v2/events"


def write(payload: dict) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    key = os.environ.get("COINMARKETCAL_API_KEY", "").strip()
    now = dt.datetime.now(dt.timezone.utc)
    if not key:
        write({"status": "not_configured", "events": [], "updated_at": None})
        print("COINMARKETCAL_API_KEY is not configured; Pages will show setup guidance.")
        return 0

    params = urlencode({
        "coins": "bitcoin,ethereum,solana",
        "from": now.date().isoformat(),
        "limit": 100,
        "sortBy": "date_asc",
    })
    request = Request(
        f"{API_URL}?{params}",
        headers={"x-api-key": key, "Accept": "application/json", "User-Agent": "C4C-Crypto-Trader/1.0"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        print(f"CoinMarketCal request failed: {type(exc).__name__}", file=sys.stderr)
        write({"status": "unavailable", "events": [], "updated_at": now.isoformat(),
               "message": "Crypto events could not be refreshed. Try again later."})
        return 0

    events = []
    raw_events = result.get("data", []) if isinstance(result, dict) else []
    for item in raw_events if isinstance(raw_events, list) else []:
        if not isinstance(item, dict):
            continue
        event_date = item.get("date")
        try:
            parsed_date = dt.datetime.fromisoformat(str(event_date).replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            continue
        if parsed_date.tzinfo is None:
            parsed_date = parsed_date.replace(tzinfo=dt.timezone.utc)
        if parsed_date < now - dt.timedelta(hours=1):
            continue
        coins = item.get("coins") if isinstance(item.get("coins"), list) else []
        symbols = [coin["symbol"].upper() for coin in coins
                   if isinstance(coin, dict) and isinstance(coin.get("symbol"), str) and coin["symbol"].strip()]
        categories = item.get("categories") if isinstance(item.get("categories"), list) else []
        category = categories[0] if categories else ""
        if isinstance(category, dict):
            category = category.get("name", "")
        slug = item.get("slug", "")
        events.append({
            "id": str(item.get("id", "")),
            "title": str(item.get("title", ""))[:220],
            "description": str(item.get("description") or "")[:600],
            "displayed_date": str(item.get("displayedDate") or "Date to be confirmed")[:80],
            "date": parsed_date.astimezone(dt.timezone.utc).isoformat(),
            "estimated": bool(item.get("isEstimated")),
            "category": str(category)[:80],
            "coins": symbols,
            "impact": item.get("impact"),
            "url": f"https://coinmarketcal.com/event/{slug}" if slug else "https://coinmarketcal.com/",
            "source_url": item.get("sourceUrl") if str(item.get("sourceUrl", "")).startswith("https://") else "",
        })
    events.sort(key=lambda event: event["date"])
    write({"status": "ok", "events": events, "updated_at": now.isoformat(),
           "source": "CoinMarketCal"})
    print(f"Wrote {len(events)} upcoming BTC, ETH, and SOL events.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
