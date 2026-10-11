"""Shared LLM client with global throttling.

Free LLM tiers (e.g. z.ai glm-4.5-flash) allow only ~1-2 requests per minute.
Every LLM call in the app goes through this single queue so calls never stack
up: minimum spacing between requests, one 429-retry with backoff, and a
graceful retry without response_format for providers that lack JSON mode.
"""
import asyncio
import logging
import time

import httpx

from .config import settings

log = logging.getLogger("llm")

MIN_INTERVAL = 35.0  # seconds between LLM calls
_lock = asyncio.Lock()
_last_call = 0.0


async def chat(body: dict) -> dict:
    """Send a chat completion; returns the full JSON response."""
    global _last_call
    # glm-4.5 models are "thinking" models; structured JSON tasks don't need
    # the reasoning phase and it makes responses far slower.
    body = {"thinking": {"type": "disabled"}, **body}
    async with _lock:  # serialize all callers; they wait here instead of 429-ing
        wait = MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
        async with httpx.AsyncClient(timeout=90) as client:
            for attempt in range(3):
                r = await client.post(f"{settings.ai_base_url}/chat/completions",
                                      json=body, headers=headers)
                _last_call = time.time()
                if r.status_code == 429 and attempt < 2:
                    log.info("LLM rate-limited, waiting 45s and retrying")
                    await asyncio.sleep(45)
                    continue
                if r.status_code >= 400 and "response_format" in body:
                    body = dict(body)
                    body.pop("response_format", None)  # provider lacks JSON mode
                    continue
                if r.status_code >= 400 and "thinking" in body:
                    body = dict(body)
                    body.pop("thinking", None)  # provider doesn't support the flag
                    continue
                break
        r.raise_for_status()
        return r.json()
