"""Market news + sentiment analysis.

Works with zero configuration:
- pulls RSS headlines (CoinDesk / CoinTelegraph / Decrypt),
- scores them with a built-in bullish/bearish lexicon, weighted by recency,
- adds the crypto Fear & Greed index (alternative.me, free).

If AI_API_KEY is set, an OpenAI-compatible LLM re-analyses the headlines and
returns a narrative summary + per-coin verdicts (graceful fallback to the
lexicon on any failure).
"""
import asyncio
import datetime as dt
import html as html_mod
import json
import logging
import math
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

def get_provider_manager():
    return ai_provider.get_global_provider_manager()

import httpx

from . import ai_provider
from .config import settings

log = logging.getLogger("news")

FEEDS = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("CoinTelegraph", "https://cointelegraph.com/rss"),
    ("Decrypt", "https://decrypt.co/feed"),
]
FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1"
UA = "Mozilla/5.0 (compatible; AICryptoTrader/1.0; local personal bot)"

BULLISH = {
    "surge": 2, "surges": 2, "soar": 2, "soars": 2, "rally": 2, "rallies": 2,
    "bullish": 2, "ath": 2, "all-time high": 3, "record high": 3, "breakout": 2,
    "upgrade": 1.5, "adoption": 1.5, "partnership": 1.5, "approval": 2.5,
    "approved": 2.5, "inflow": 1.5, "inflows": 1.5, "institutional": 1,
    "accumulat": 1.5, "buy the dip": 1, "recovery": 1.5, "rebound": 1.5,
    "jumps": 1.5, "jump": 1.2, "gains": 1, "climbs": 1.5, "rise": 1, "rises": 1,
    "bull run": 2, "halving": 1.5, "short squeeze": 2, "whale buying": 2,
    "reserve": 1, "treasury": 1, "green": 0.8, "surging": 2, "milestone": 1.2,
}
BEARISH = {
    "crash": 3, "crashes": 3, "plunge": 2.5, "plunges": 2.5, "dump": 2, "dumps": 2,
    "bearish": 2, "hack": 3, "hacked": 3, "exploit": 3, "breach": 2.5, "scam": 2.5,
    "fraud": 2.5, "lawsuit": 2, "sues": 2, "charges": 1.5, "ban": 2.5, "bans": 2.5,
    "banned": 2.5, "outflow": 1.5, "outflows": 1.5, "liquidation": 2.5,
    "liquidations": 2.5, "liquidated": 2.5, "sell-off": 2, "selloff": 2,
    "fear": 1.2, "fud": 1.5, "delist": 2.5, "delisting": 2.5, "bankrupt": 3,
    "insolvency": 3, "ponzi": 3, "rug pull": 3, "whale selling": 2, "decline": 1,
    "drops": 1.2, "falls": 1.2, "sink": 1.5, "sinks": 1.5, "tumble": 1.8,
    "tumbles": 1.8, "warn": 1.3, "warning": 1.3, "risk": 0.8, "plummet": 2.5,
    "slump": 1.8, "correction": 1, "down": 0.6, "fraud": 2.5, "arrest": 1.5,
}

KNOWN_COIN_KEYWORDS = {
    "BTC": ["bitcoin", "btc"], "ETH": ["ethereum", "ether", "eth"],
    "BNB": ["bnb", "binance coin"], "SOL": ["solana", "sol"],
    "XRP": ["xrp", "ripple"], "ADA": ["cardano", "ada"],
    "DOGE": ["dogecoin", "doge"], "AVAX": ["avalanche", "avax"],
    "LINK": ["chainlink"], "DOT": ["polkadot"], "LTC": ["litecoin"],
    "TRX": ["tron"], "SHIB": ["shiba", "shib"], "MATIC": ["polygon", "matic"],
    "POL": ["polygon", "pol"], "PEPE": ["pepe"], "TON": ["toncoin"],
    "NEAR": ["near protocol"], "ATOM": ["cosmos"], "ARB": ["arbitrum"],
    "OP": ["optimism"], "APT": ["aptos"], "SUI": ["sui"],
}


def coin_keywords(symbol: str) -> list[str]:
    base = symbol[:-4] if symbol.endswith("USDT") else symbol
    kws = list(KNOWN_COIN_KEYWORDS.get(base, []))
    kws += [base.lower(), symbol.lower()]
    return sorted(set(kws))


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html_mod.unescape(text)).strip()


def _parse_ts(raw: str) -> dt.datetime | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone(dt.timezone.utc)
    except Exception:
        pass
    try:
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


def _find_text(el: ET.Element, names: set[str]) -> str:
    for child in el.iter():
        if child.tag.split("}")[-1] in names and (child.text or "").strip():
            return child.text.strip()
    return ""


def _find_link(el: ET.Element) -> str:
    for child in el.iter():
        if child.tag.split("}")[-1] == "link":
            link = child.get("href") or (child.text or "").strip()
            if link:
                return link
    return ""


def parse_feed(xml_text: str) -> list[dict]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items = []
    seen_titles = set()
    for entry in root.iter():
        tag = entry.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        title = _clean(_find_text(entry, {"title"}))
        if not title or title.lower() in seen_titles:
            continue
        seen_titles.add(title.lower())
        summary = _clean(_find_text(entry, {"description", "summary", "encoded"}))
        items.append({
            "title": title[:300],
            "url": _find_link(entry),
            "summary": summary[:1200],
            "published": _find_ts_or_none(entry),
        })
        if len(items) >= 30:
            break
    return items


def _find_ts_or_none(entry: ET.Element) -> dt.datetime | None:
    return _parse_ts(_find_text(entry, {"pubDate", "pubdate", "updated", "published", "dc:date"}))


def score_text(text: str) -> float:
    tl = text.lower()
    s = 0.0
    for w, wt in BULLISH.items():
        if w in tl:
            s += wt
    for w, wt in BEARISH.items():
        if w in tl:
            s -= wt
    return max(-1.0, min(1.0, s / 3.0))


def label(score: float) -> str:
    if score > 0.12:
        return "Bullish"
    if score < -0.12:
        return "Bearish"
    return "Neutral"


async def _fetch_feed(client: httpx.AsyncClient, name: str, url: str):
    r = await client.get(url, headers={"User-Agent": UA}, timeout=15, follow_redirects=True)
    r.raise_for_status()
    return name, r.text


async def _fear_greed(client: httpx.AsyncClient) -> dict | None:
    try:
        r = await client.get(FEAR_GREED_URL, timeout=10)
        d = r.json()["data"][0]
        return {"value": int(d["value"]), "classification": d["value_classification"]}
    except Exception:
        return None


async def _ai_enhance(items: list[dict]) -> dict:
    """Ask an OpenAI-compatible LLM for a structured market read."""
    lines = []
    now = dt.datetime.now(dt.timezone.utc)
    for i, it in enumerate(items[:25], 1):
        age = ""
        if it.get("published"):
            age_h = max(0, (now - it["published"]).total_seconds() / 3600)
            age = f" ({age_h:.0f}h ago)"
        lines.append(f"{i}. [{it['source']}] {it['title']}{age}")
    system = (
        "You are a cautious crypto market analyst. Analyse the headlines for "
        "overall market sentiment and per-coin sentiment. Respond with ONLY a "
        'JSON object: {"market_sentiment": "bullish|bearish|neutral", '
        '"market_score": <number -1..1>, '
        '"coins": {"<SYMBOL>": {"sentiment": "bullish|bearish|neutral", '
        '"score": <number -1..1>, "reason": "<one short sentence>"}}, '
        '"key_events": ["<short event>", ...], '
        '"summary": "<2-3 sentence market summary>"}'
    )
    user = "Headlines:\n" + "\n".join(lines)
    
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user}
    ]
    
    try:
        provider_manager = get_provider_manager()
        result = await provider_manager.call_llm(
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"}
        )
        
        content = result["content"]
        return json.loads(content)
    except Exception as e:
        log.warning("Multi-provider AI news enhancement failed: %s", e)
        raise


async def fetch_news(symbols: list[str]) -> dict:
    now = dt.datetime.now(dt.timezone.utc)
    items: list[dict] = []
    errors: list[str] = []
    async with httpx.AsyncClient(follow_redirects=True) as client:
        results = await asyncio.gather(
            *(_fetch_feed(client, name, url) for name, url in FEEDS),
            _fear_greed(client),
            return_exceptions=True,
        )
    fg = None
    for res in results[:-1]:
        if isinstance(res, Exception):
            errors.append(str(res)[:120])
            continue
        name, text = res
        for it in parse_feed(text):
            it["source"] = name
            items.append(it)
    fg = results[-1] if not isinstance(results[-1], Exception) else None

    kw_map = {s: coin_keywords(s) for s in symbols}
    for it in items:
        text = it["title"]
        it["score"] = round(score_text(text), 3)
        if it.get("published"):
            age_h = max(0.0, (now - it["published"]).total_seconds() / 3600)
            it["_weight"] = math.exp(-age_h / 12.0) if age_h < 48 else 0.05
            it["age_h"] = round(age_h, 1)
        else:
            it["_weight"] = 0.5
            it["age_h"] = None
        it["coins"] = [s for s, kws in kw_map.items() if any(k in text.lower() for k in kws)]
        it.pop("published", None)
        if it.get("age_h") is not None:
            it["age"] = f"{int(it['age_h'])}h ago" if it["age_h"] >= 1 else "just now"
        it.pop("age_h", None)

    items.sort(key=lambda x: x["_weight"], reverse=True)
    items = items[:40]

    total_w = sum(it["_weight"] for it in items) or 1.0
    market_score = sum(it["score"] * it["_weight"] for it in items) / total_w

    per_coin = {}
    for s in symbols:
        rel = [it for it in items if s in it["coins"]]
        if rel:
            w = sum(it["_weight"] for it in rel) or 1.0
            score = sum(it["score"] * it["_weight"] for it in rel) / w
            per_coin[s] = {"score": round(score, 3), "label": label(score), "count": len(rel)}
        else:
            per_coin[s] = {"score": round(market_score, 3), "label": label(market_score),
                           "count": 0, "note": "no coin-specific news, using market score"}

    ai_block = {"enabled": bool(settings.ai_api_key), "summary": None, "key_events": [],
                "market_score": None, "error": None}
    if settings.ai_api_key and items:
        try:
            ai = await _ai_enhance(items)
            ai_block.update({
                "summary": ai.get("summary"),
                "key_events": ai.get("key_events", []),
                "market_score": ai.get("market_score"),
                "coins": ai.get("coins", {}),
            })
            if isinstance(ai_block.get("market_score"), (int, float)):
                ai_block["market_score"] = max(-1.0, min(1.0, float(ai_block["market_score"])))
                market_score = ai_block["market_score"]
                per_coin_market_label = label(market_score)
            for s in symbols:
                base = s[:-4] if s.endswith("USDT") else s
                aic = ai_block.get("coins", {}).get(base) or ai_block.get("coins", {}).get(s)
                if aic:
                    per_coin[s]["ai_reason"] = aic.get("reason")
                    if isinstance(aic.get("score"), (int, float)):
                        per_coin[s]["score"] = max(-1.0, min(1.0, float(aic["score"])))
                        per_coin[s]["label"] = label(per_coin[s]["score"])
        except Exception as e:
            log.warning("AI news enhancement failed: %s", e)
            ai_block["error"] = str(e)[:200]

    out_items = []
    for it in items[:30]:
        w = it.pop("_weight", None)
        it["label"] = label(it["score"])
        out_items.append(it)

    return {
        "fetched_at": now.isoformat(timespec="seconds"),
        "market": {"score": round(market_score, 3), "label": label(market_score)},
        "fear_greed": fg,
        "coins": per_coin,
        "items": out_items,
        "ai": ai_block,
        "source_errors": errors,
    }
