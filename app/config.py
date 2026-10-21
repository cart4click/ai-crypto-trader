"""Central configuration, loaded from .env in the project root."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    binance_api_key: str = os.getenv("BINANCE_API_KEY", "")
    binance_api_secret: str = os.getenv("BINANCE_API_SECRET", "")
    binance_testnet: bool = _bool(os.getenv("BINANCE_TESTNET"), True)

    ai_api_key: str = os.getenv("AI_API_KEY", "")
    ai_base_url: str = os.getenv("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    ai_model: str = os.getenv("AI_MODEL", "gpt-4o-mini")
    ai_configured: bool = bool(ai_api_key)  # Backward compatibility

    telegram_bot_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_allowed_chat_ids: list[int] = [
        int(x) for x in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if x
    ]

    app_host: str = os.getenv("APP_HOST", "127.0.0.1")
    app_port: int = int(os.getenv("APP_PORT", "8000"))
    app_cors_origins: list[str] = [
        origin.strip().rstrip("/")
        for origin in os.getenv("APP_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]

    # This is a browser-safe Supabase key, not a service-role key. SMTP remains
    # configured inside Supabase and is never read by this app.
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_publishable_key: str = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

    # Cloudflare Turnstile Site Key (public, browser-safe).
    # The Secret Key is configured in Supabase Auth settings, not here.
    turnstile_site_key: str = os.getenv("TURNSTILE_SITE_KEY", "")

    dry_run: bool = _bool(os.getenv("DRY_RUN"), True)
    max_order_usdt: float = float(os.getenv("MAX_ORDER_USDT", "100"))
    max_daily_usdt: float = float(os.getenv("MAX_DAILY_USDT", "500"))
    poll_seconds: int = int(os.getenv("POLL_SECONDS", "60"))

    data_dir: Path = BASE_DIR / "data"
    
    # Whale Alert API configuration
    whale_alert_api_key: str = os.getenv("WHALE_ALERT_API_KEY", "")
    whale_alert_api_url: str = os.getenv("WHALE_ALERT_API_URL", "https://api.whale-alert.io/v1")
    whale_threshold_usdt: float = float(os.getenv("WHALE_THRESHOLD_USDT", "1000000"))


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)


def has_ai_providers():
    """Check if any AI providers are configured in new multi-provider format."""
    for i in range(1, 10):
        provider_config = os.getenv(f"AI_PROVIDER_{i}", "")
        if provider_config:
            parts = provider_config.split("|")
            if len(parts) >= 4:  # Has provider configuration (even without key)
                return True
    return False
