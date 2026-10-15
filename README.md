# 🤖 AI Crypto Trader — local

A locally-hosted AI trading assistant for Binance **spot** trading:

| # | Requirement | How it works |
|---|-------------|--------------|
| 1 | Binance buy/sell, **no withdrawals** | Spot market orders via Binance API. The codebase contains **zero** withdrawal/transfer calls, and the app refuses to help create keys with withdrawal rights (see Security). |
| 2 | AI forecast (low/high + graph) and news analysis | Bootstrap Monte-Carlo simulation (2,000 paths) predicts the next-24h **low/high with a 95% confidence fan** on the chart; news headlines (CoinDesk / CoinTelegraph / Decrypt) are scored bullish/bearish + Fear & Greed index. Optionally an LLM (OpenAI-compatible) writes a market summary. |
| 3 | Private Telegram notifications + confirmations | Bot token + **chat-id whitelist**. Every LIVE order waits for your ✅ Confirm / ❌ Cancel button press in your private chat. Nobody else can trigger or confirm anything. |
| 4 | Locally hosted web app | FastAPI serves a dashboard at `http://127.0.0.1:8000` — chart, forecast, news, positions, trade log, pending confirmations, bot controls. |
| 5 | Everything via APIs, all secure | Binance/Telegram/LLM keys live only in `.env` on your machine; server binds to 127.0.0.1; optional `APP_TOKEN` protects the UI; HTTPS to all external APIs. |
| 6 | 6% dip-buy / 6% high-sell rules + AI override | Configure per coin (defaults 6%/6%). The engine signals a buy when price ≤ anchor −6% and a sell when price ≥ avg cost +6%. **When a signal fires, the AI is consulted:** if it forecasts a *deeper* dip it says WAIT (and explains why in Telegram); same for holding out for a *higher* high before selling. |

---

## Quick start (works with zero API keys)

```bash
cd ai-crypto-trader
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # defaults are the safe ones
.venv/bin/python run.py
```

Open **http://127.0.0.1:8000** — you're in **DRY RUN** mode: real market data,
real forecasts, simulated paper trades. Add coins, press **▶ Start bot**, watch
signals and paper fills in the trade log.

## Going live (real orders) — checklist

1. **Binance API key**: binance.com → Profile → API Management → Create API
   → enable **Enable Reading** + **Enable Spot & Margin Trading** only.
   **Leave withdrawals DISABLED.** (Optionally whitelist your IP.)
2. `.env`:
   ```
   BINANCE_API_KEY=...
   BINANCE_API_SECRET=...
   BINANCE_TESTNET=false     # or keep true to try real endpoints on testnet first
   DRY_RUN=false             # <-- real orders now require Telegram/UI confirmation
   ```
3. Set up Telegram (below) so every order needs your phone confirmation.
4. Start with small caps: `MAX_ORDER_USDT`, `MAX_DAILY_USDT`.

> **Binance Spot Testnet**: keys at https://testnet.binance.vision (sign in with
> GitHub). With `BINANCE_TESTNET=true` and `DRY_RUN=false` you exercise the real
> order flow with fake money.

## Telegram setup (private channel)

This bot is designed to be a private alert system, not a public bot.

How it works:

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the **bot token** into
   `TELEGRAM_BOT_TOKEN`.
2. Start the app and send `/start` to **your** bot from the same Telegram account
   you want to use for confirmations. The bot replies with your numeric **chat id**.
3. Put that chat id in `TELEGRAM_ALLOWED_CHAT_IDS=123456789` and restart the app.
4. The app polls Telegram for updates and listens for both messages and inline buttons.

What happens when the bot sees a signal:

- It creates a pending order record with a random id.
- In live mode, it sends a Telegram message with **✅ Confirm** and **❌ Cancel** buttons.
- The user must confirm or cancel from the whitelisted chat.
- If the user confirms, the order is executed.
- If the user cancels, the order is rejected.
- If no confirmation arrives in time, the pending order expires and is auto-cancelled.

Only a whitelisted chat id can read, receive, or confirm anything. Anyone else
gets rejected with a private-bot message. Pending orders expire after 15 minutes
and are auto-cancelled if the price moved more than 1.5% from the signal.

## Optional: LLM for smarter analysis

Set any OpenAI-compatible API:
```
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1   # or Groq/DeepSeek/Ollama endpoint
AI_MODEL=gpt-4o-mini
```
The LLM summarises the news market read and adds per-coin reasoning. Without a
key everything still works — forecasting is a built-in Monte-Carlo engine and
news uses a built-in sentiment lexicon + Fear & Greed index.

## How the strategy works

Per coin: `anchor` price, `buy_dip_pct` (default 6%), `sell_high_pct` (6%),
`trade_amount_usdt`.

- **BUY** when `price ≤ anchor × (1 − 6%)`. The AI checks the 24h forecast:
  if P(even 2% deeper dip) ≥ 55% and trend isn't bullish → *AI says WAIT*
  (dry-run: no trade; live: you decide via the Confirm button).
- **SELL** when `price ≥ avg_cost × (1 + 6%)`. If the AI expects a higher high
  (P(+2% more) ≥ 55%, bullish trend, non-bearish news) → *AI says WAIT*.
- After a buy, the anchor moves to your fill price (so repeated dips average
  down); after a sell it moves to the sell price. Re-anchor anytime from the UI.

Safety rails that can't be disabled from the UI: per-order cap, daily spend
cap, Binance LOT_SIZE/min-notional compliance, price-drift guard, expiry,
DRY_RUN default.

## Security model

- Keys live **only** in `.env` (gitignored). Never logged, never returned by the API.
- **No withdrawal code exists** in this app — and your Binance key should have
  withdrawals disabled anyway, so funds physically can't leave the exchange.
- Web server binds to `127.0.0.1`. For LAN access set `APP_HOST=0.0.0.0` **and**
  `APP_TOKEN=<long random string>`; the dashboard will ask for the token once.
- Telegram is a private channel via chat-id whitelist.
- All external calls are HTTPS (Binance, Telegram, news, LLM).

## Public website deployment

The included GitHub Actions workflow publishes only the `frontend/` directory
to GitHub Pages. The price chart reads public hourly candles from Binance and
works without the app server. The static site also has a browser-saved watchlist
of popular Binance USDT pairs and can load their public prices without an API
key. GitHub Pages cannot run the FastAPI app, so forecasts, trading controls,
and email sign-in require a separate server running `run.py`.

1. Deploy the FastAPI app on a server or Python application host with a public
   **HTTPS** URL. Keep `APP_HOST=0.0.0.0`, set a long `APP_TOKEN`, and set
   `APP_CORS_ORIGINS=https://www.cart4click.com,https://cart4click.com`.
2. In `frontend/config.js`, set `window.API_BASE_URL` to that backend's HTTPS
   origin (for example `https://api.example.com`), then publish the Pages site
   to enable the dashboard API features. Without it, quick coin buttons still
   let visitors select symbols for the public Binance chart.
3. In GitHub, open **Settings → Pages** and enable **Enforce HTTPS** for the
   custom domain. In IONOS, keep the domain's DNS pointed at GitHub Pages; the
   certificate and HTTP-to-HTTPS redirect are managed by GitHub Pages.

### Upcoming crypto events feed

The Pages workflow refreshes the public BTC, ETH, and SOL event snapshot every
six hours from CoinMarketCal. To enable it, create a CoinMarketCal API key and
add it in **GitHub → Settings → Secrets and variables → Actions** as
`COINMARKETCAL_API_KEY`. Never add the key to `frontend/` or commit it. After
adding the secret, run **Actions → Deploy Pages → Run workflow** once; the
workflow also refreshes the feed on its six-hour schedule. Without this secret,
the website shows setup instructions in the events panel instead of an empty
or misleading event list.

### Email sign-in setup

The sign-in page sends a six-digit, single-use code through the FastAPI backend.
Configure an authenticated SMTP mailbox on that backend before enabling it:

```dotenv
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_USERNAME=your-mailbox@example.com
SMTP_PASSWORD=your-mailbox-password
SMTP_FROM_EMAIL=your-mailbox@example.com
```

Use the SMTP host and credentials provided by your email host (IONOS if using
an IONOS mailbox). Keep these values only in the backend environment, never in
the GitHub Pages frontend. The login endpoints are exempt from `APP_TOKEN` so
visitors can request a code; configure `APP_CORS_ORIGINS` for the website's
HTTPS origins and set `API_BASE_URL` to the HTTPS backend origin. Codes expire
after 10 minutes, allow five verification attempts, and are rate limited.
The current lightweight sign-in sessions and rate limits are held in backend
memory, so a backend restart clears existing sign-ins.

### Google sign-in setup

Google sign-in uses Google's Identity Services button and verifies its ID token
on the FastAPI backend. Create a **Web application** OAuth client in Google
Cloud, add `https://www.cart4click.com` and `https://cart4click.com` as
authorized JavaScript origins, then set the same client ID in
`frontend/config.js` (`window.GOOGLE_CLIENT_ID`) and the backend environment
(`GOOGLE_CLIENT_ID`). The ID is public; never put a client secret in the
frontend. Deploy the updated backend and frontend over HTTPS with the CORS
origins above. Until both IDs and the HTTPS API are configured, the page shows
Google sign-in as unavailable and email login remains available when SMTP is
configured.

Do not put Binance, Telegram, or AI provider credentials in `frontend/` or
`config.js`; those belong only in the backend's environment. The chart displays
an API error directly when the backend is missing or unreachable.

## Project layout

```
app/
  binance_client.py   # market data + spot orders (no withdrawals)
  forecast.py         # Monte-Carlo 24h low/high prediction + probabilities
  indicators.py       # RSI, MACD, EMA, Bollinger, ATR
  news.py             # RSS + lexicon/Fear&Greed + optional LLM analysis
  strategy.py         # bot loop: 6% rules + AI override + confirmations
  trader.py           # order execution with safety caps
  telegram_bot.py     # private channel, Confirm/Cancel buttons
  state_store.py      # JSON persistence (data/state.json)
  main.py             # FastAPI server + REST API
frontend/             # dashboard (Chart.js)
run.py
```

## Ideas to make it smarter (v2)

- **Stop-loss protection** — this bot has no stop-loss; a hard −8% stop per
  position would be the single best upgrade.
- **Backtesting** — replay the strategy on 1–3 years of klines and show
  equity curve / win rate before risking money.
- **Learned thresholds** — replace the fixed 6% with ATR%-based (volatility-
  adjusted) thresholds per coin.
- **Trained ML model** — LightGBM/LSTM on your own features, retrained weekly,
  with the Monte-Carlo band as a sanity check.
- **More signals** — funding rates, liquidations, on-chain flows, whale alerts,
  multi-timeframe consensus (15m + 1h + 4h).
- **Limit orders instead of market** — place limit bids at the dip target.
- **WebSocket price streaming** for sub-second reactions.
- **SQLite + Docker** for durability and one-command deployment.
- **Daily Telegram digest** with a PNG chart of the forecast.

## Disclaimer

Educational software, not financial advice. Crypto is volatile; the built-in
forecast is a statistical model, not a crystal ball. Run DRY RUN for weeks,
check the trade log, and only then consider small live amounts.
