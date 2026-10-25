"""Build a small public news/events snapshot for the static GitHub Pages site."""
from __future__ import annotations

import datetime as dt
import html
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend" / "public-feed.json"
HEADERS = {"User-Agent": "Cart4Click-Public-Feed/1.0"}


def text(value: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def fetch(query: str, limit: int = 18) -> list[dict]:
    params = urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    url = f"https://news.google.com/rss/search?{params}"
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=20) as response:
        root = ET.fromstring(response.read())
    items = []
    for item in root.findall(".//item")[:limit]:
        items.append({
            "title": text(item.findtext("title")),
            "summary": text(item.findtext("description"))[:700],
            "url": text(item.findtext("link")) or "https://news.google.com/",
            "source": text(item.findtext("source")) or "Google News",
            "published": text(item.findtext("pubDate")),
        })
    return items


def unique(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result = []
    for item in items:
        key = item.get("url") or item.get("title")
        if key and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def main() -> None:
    try:
        news = unique(fetch("cryptocurrency market bitcoin ethereum solana", 24))
    except Exception as error:
        print(f"news feed unavailable: {error}")
        news = []
    try:
        events = unique(fetch("crypto upcoming event token unlock mainnet listing conference", 12))
    except Exception as error:
        print(f"event feed unavailable: {error}")
        events = []
    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "news": news,
        "events": events,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(news)} news items and {len(events)} event items to {OUTPUT}")


if __name__ == "__main__":
    main()
