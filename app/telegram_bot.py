"""Private Telegram channel for signals & confirmations.

Security model:
- The bot token is a secret; anyone who has it could message the bot, so an
  explicit whitelist (TELEGRAM_ALLOWED_CHAT_IDS) is enforced: any message or
  button press from a non-whitelisted chat is rejected and logged.
- Confirm/Cancel inline buttons carry a random pending-order id; only the
  whitelisted owner can press them.
- The bot never exposes API keys; it talks to Telegram over HTTPS.
"""
import asyncio
import logging

import httpx

from .config import settings

log = logging.getLogger("telegram")


class TelegramBot:
    def __init__(self):
        self.token = settings.telegram_bot_token
        self.allowed = set(settings.telegram_allowed_chat_ids)
        self.base = f"https://api.telegram.org/bot{self.token}"
        self._client = httpx.AsyncClient(timeout=40)
        self._polling = False

    @property
    def configured(self) -> bool:
        return bool(self.token)

    @property
    def ready(self) -> bool:
        return self.configured and bool(self.allowed)

    def setup_help(self) -> str:
        return (
            "Telegram bot setup:\n"
            "1) Create a bot with @BotFather and copy its token into TELEGRAM_BOT_TOKEN.\n"
            "2) Start the app and send /start to the bot from your phone.\n"
            "3) Copy the numeric chat id shown by the bot into TELEGRAM_ALLOWED_CHAT_IDS.\n"
            "4) Restart the app. Only that chat can receive signals and confirm trades."
        )

    def chat_allowed(self, chat_id: int) -> bool:
        return chat_id in self.allowed

    async def close(self):
        await self._client.aclose()

    async def api(self, method: str, payload: dict | None = None):
        if not self.configured:
            return None
        try:
            r = await self._client.post(f"{self.base}/{method}", json=payload or {}, timeout=35)
            d = r.json()
            if not d.get("ok"):
                log.warning("Telegram %s failed: %s", method, d.get("description", d))
                return None
            return d.get("result")
        except Exception as e:
            log.warning("Telegram %s error: %s", method, e)
            return None

    async def send(self, chat_id: int, text: str, reply_markup: dict | None = None):
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return await self.api("sendMessage", payload)

    async def broadcast(self, text: str, reply_markup: dict | None = None):
        if not self.ready:
            return
        for chat_id in self.allowed:
            await self.send(chat_id, text, reply_markup)

    def stop(self):
        self._polling = False

    async def poll_loop(self, handler):
        """Long-poll getUpdates; handler(update_dict) is called per update."""
        if not self.configured:
            log.info("Telegram not configured — running without Telegram notifications")
            return
        if not self.allowed:
            log.warning(
                "Telegram bot is configured but no allowed chat ids are set. "
                "Set TELEGRAM_ALLOWED_CHAT_IDS to your numeric chat id, then restart the app. "
                "To get that id, send /start to the bot after the token is set."
            )
        offset = 0
        self._polling = True
        log.info("Telegram polling started (%d allowed chat(s))", len(self.allowed))
        while self._polling:
            try:
                r = await self._client.post(
                    f"{self.base}/getUpdates",
                    json={"timeout": 25, "offset": offset,
                          "allowed_updates": ["message", "callback_query"]},
                    timeout=35,
                )
                d = r.json()
                if not d.get("ok"):
                    await asyncio.sleep(5)
                    continue
                for upd in d.get("result", []):
                    offset = max(offset, upd["update_id"] + 1)
                    try:
                        await handler(upd)
                    except Exception:
                        log.exception("telegram update handler failed")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("telegram poll error: %s", e)
                await asyncio.sleep(5)
