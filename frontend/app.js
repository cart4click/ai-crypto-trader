/* AI Crypto Trader — dashboard logic */
const $ = (s) => document.querySelector(s);
let chart = null;
let drawingTool = null;
let chartDrawings = [];
let chartDrawingKey = "";
let selected = "BTCUSDT";
let chartStyle = "line";
const CHART_INTERVALS = ["15m", "30m", "1h", "4h", "1d"];
let chartInterval = "1h";
const CHART_VIEW_STORAGE_KEY = "market-chart-viewport";
let chartViewport = null;
const INDICATOR_OPTIONS = {
  supertrend: "Multi-timeframe Supertrend",
  rsi: "Relative Strength Index (RSI)",
  macd: "MACD",
  ema: "EMA 20 / 50 crossover",
  bollinger: "Bollinger Bands (20, 2)",
  atr: "Average True Range (ATR 14)",
};
const INDICATORS_KEY = "market-indicators";
let activeIndicators = [];
let marketRefreshInFlight = false;
let forecastApiUnavailable = false;
let marketStream = null;
let marketStreamKey = "";
let marketStreamReconnect = null;
let pendingMarketKline = null;
const PRICE_ALERTS_KEY = "market-price-alerts-v1";
let priceAlerts = [];

let coinsCache = {};
let forecastCache = null;
const API_BASE_URL = (window.API_BASE_URL || "").replace(/\/+$/, "");
const PUBLIC_DASHBOARD = document.documentElement.dataset.publicDashboard === "true";
const accountLink = $("#account-link");
const accountEmail = $("#account-email");
let signedInUser = null;
let authResolved = false;
function loginForAction() {
  const target = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login.html?returnTo=${encodeURIComponent(target)}&message=Sign in to use this feature.`);
}
async function requireActionSignIn() {
  try {
    signedInUser = await window.C4CAuth.getVerifiedUser();
  } catch {
    signedInUser = null;
  }
  if (signedInUser) return true;
  loginForAction();
  return false;
}
function renderAccountLink(user = signedInUser) {
  if (!accountLink) return;
  signedInUser = user || null;
  accountLink.textContent = signedInUser ? "Sign out" : "Sign in";
  accountLink.onclick = () => signedInUser ? void window.C4CAuth.logout() : loginForAction();
}
function renderAccountEmail(user) {
  if (!accountEmail) return;
  const email = user?.email;
  accountEmail.textContent = email ? `Signed in as ${email}` : "";
  accountEmail.hidden = !email;
}
renderAccountLink();
document.addEventListener("c4c:authenticated", event => {
  authResolved = true;
  renderAccountLink(event.detail?.user);
  renderAccountEmail(event.detail?.user);
  syncDashboardPreferences(event.detail?.user);
  refreshMarket(true);
});
void window.C4CAuth.getVerifiedUser().then(user => {
  authResolved = true;
  renderAccountLink(user);
  renderAccountEmail(user);
  syncDashboardPreferences(user);
  refreshMarket(true);
}).catch(() => {
  authResolved = true;
  renderAccountLink(null);
  syncDashboardPreferences(null);
  refreshMarket(true);
});

function loadChartDrawings(symbol) {
  if (!signedInUser) return [];
  chartDrawingKey = `chart-drawings:${symbol}:${chartInterval}`;
  try {
    const saved = JSON.parse(localStorage.getItem(chartDrawingKey) || "[]");
    return Array.isArray(saved) ? saved.filter(line =>
      (line.type === "horizontal" && Number.isFinite(line.price)) ||
      (line.type === "vertical" && Number.isFinite(line.index)) ||
      (line.type === "freehand" && Array.isArray(line.points) && line.points.length > 1 && line.points.every(point => Number.isFinite(point.index) && Number.isFinite(point.price))) ||
      (line.type === "text" && Number.isFinite(line.index) && Number.isFinite(line.price) && typeof line.text === "string" && line.text.length > 0)) : [];
  } catch { return []; }
}

function saveChartDrawings() {
  if (!signedInUser) return;
  if (chartDrawingKey) localStorage.setItem(chartDrawingKey, JSON.stringify(chartDrawings));
  renderDrawingManager();
}

function drawingTitle(drawing, index) {
  if (drawing.label?.trim()) return drawing.label.trim();
  if (drawing.type === "text") return drawing.text || `Text ${index + 1}`;
  const types = { horizontal: "Horizontal line", vertical: "Vertical line", freehand: "Freehand" };
  const typeName = types[drawing.type] || "Drawing";
  const ordinal = chartDrawings.slice(0, index + 1).filter(item => item.type === drawing.type).length;
  return `${typeName} ${ordinal}`;
}

function renderDrawingManager() {
  const list = $("#drawing-manager-list");
  if (!list) return;
  const count = $("#drawing-manager-count");
  if (count) count.textContent = `(${chartDrawings.length})`;
  if (!chartDrawings.length) {
    list.innerHTML = '<div class="muted small">No chart drawings yet.</div>';
    return;
  }
  list.innerHTML = chartDrawings.map((drawing, index) => {
    const color = /^#[0-9a-f]{6}$/i.test(drawing.color || "") ? drawing.color : "#fbbf24";
    return `<div class="drawing-manager-row ${drawing.hidden ? "is-hidden" : ""}" data-drawing-index="${index}">
      <input class="drawing-manager-color" data-drawing-color="${index}" type="color" value="${color}" aria-label="Color for ${esc(drawingTitle(drawing, index))}" />
      <input class="drawing-manager-name" data-drawing-label="${index}" type="text" maxlength="48" value="${esc(drawingTitle(drawing, index))}" aria-label="Rename drawing ${index + 1}" />
      <button class="btn tiny" type="button" data-drawing-manager-action="toggle" aria-label="${drawing.hidden ? "Show" : "Hide"} ${esc(drawingTitle(drawing, index))}">${drawing.hidden ? "Show" : "Hide"}</button>
      <button class="btn tiny danger" type="button" data-drawing-manager-action="delete" aria-label="Delete ${esc(drawingTitle(drawing, index))}">Delete</button>
    </div>`;
  }).join("");
}
renderDrawingManager();

function savePriceAlerts() {
  if (!signedInUser) return;
  localStorage.setItem(PRICE_ALERTS_KEY, JSON.stringify(priceAlerts));
  renderPriceAlerts();
  if (selected) startMarketStream(selected, chartInterval);
}

function renderPriceAlerts() {
  const list = $("#price-alert-list");
  if (!list) return;
  const visible = priceAlerts.filter(alert => alert.symbol === selected);
  $("#price-alert-count").textContent = `(${visible.filter(alert => alert.active !== false).length} active)`;
  list.innerHTML = visible.length ? visible.map(alert => `<div class="price-alert-row ${alert.active === false ? "triggered" : ""}" data-price-alert="${esc(alert.id)}">
    <span><b>${alert.condition === "above" ? "At or above" : "At or below"}</b> ${fmtMarketPrice(alert.target)} ${alert.active === false ? "· triggered" : "· waiting"}</span>
    <button class="btn tiny danger" type="button" data-remove-price-alert="${esc(alert.id)}">Remove</button>
  </div>`).join("") : '<span class="muted small">No alerts for this coin. Add one above.</span>';
}

function checkPriceAlerts(symbol, price) {
  if (!Number.isFinite(price)) return;
  let changed = false;
  for (const alert of priceAlerts) {
    if (alert.symbol !== symbol || alert.active === false) continue;
    const triggered = alert.condition === "above" ? price >= alert.target : price <= alert.target;
    if (!triggered) continue;
    alert.active = false;
    alert.triggeredAt = new Date().toISOString();
    changed = true;
    const message = `${symbol} reached ${fmtMarketPrice(price)} (${alert.condition === "above" ? "target" : "downside"} alert ${fmtMarketPrice(alert.target)}).`;
    toast(message);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("AI Crypto Trader price alert", { body: message, icon: "/favicon.png" });
    }
  }
  if (changed) savePriceAlerts();
}

$("#price-alert-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!await requireActionSignIn()) return;
  const target = Number($("#price-alert-value").value);
  if (!selected || !Number.isFinite(target) || target <= 0) {
    toast("Enter a target price greater than zero.", true);
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* in-page alerts still work */ }
  }
  priceAlerts.unshift({ id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`, symbol: selected, target, condition: $("#price-alert-condition").value, active: true, createdAt: new Date().toISOString() });
  $("#price-alert-value").value = "";
  savePriceAlerts();
  toast(`Price alert added for ${selected}.`);
});
$("#price-alert-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-remove-price-alert]");
  if (!button) return;
  if (!await requireActionSignIn()) return;
  priceAlerts = priceAlerts.filter(alert => alert.id !== button.dataset.removePriceAlert);
  savePriceAlerts();
});
renderPriceAlerts();

$("#drawing-manager-list").addEventListener("input", async event => {
  if (!signedInUser && !await requireActionSignIn()) return;
  const control = event.target;
  const index = Number(control.dataset.drawingLabel ?? control.dataset.drawingColor);
  const drawing = chartDrawings[index];
  if (!drawing) return;
  if (control.matches("[data-drawing-label]")) drawing.label = control.value.slice(0, 48);
  if (control.matches("[data-drawing-color]")) {
    drawing.color = /^#[0-9a-f]{6}$/i.test(control.value) ? control.value : "#fbbf24";
    if (chart) chart.update("none");
  }
  if (chartDrawingKey) localStorage.setItem(chartDrawingKey, JSON.stringify(chartDrawings));
});
$("#drawing-manager-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-drawing-manager-action]");
  if (!button) return;
  if (!await requireActionSignIn()) return;
  const row = button.closest("[data-drawing-index]");
  const drawing = chartDrawings[Number(row?.dataset.drawingIndex)];
  if (!drawing) return;
  if (button.dataset.drawingManagerAction === "toggle") drawing.hidden = !drawing.hidden;
  if (button.dataset.drawingManagerAction === "delete") chartDrawings.splice(Number(row.dataset.drawingIndex), 1);
  saveChartDrawings();
  if (chart) chart.update("none");
  updateHiddenDrawingButton();
});

function marketNotesKey(symbol = selected) { return `market-notes:${symbol}`; }
function renderMarketNotes() {
  const field = $("#market-notes");
  if (!field) return;
  field.value = signedInUser ? localStorage.getItem(marketNotesKey()) || "" : "";
  $("#market-notes-status").textContent = signedInUser
    ? (selected ? `Saved on this device · ${selected.replace("USDT", "/USDT")}` : "Select a coin to keep notes per market.")
    : "Sign in to save notes for a market.";
}
renderMarketNotes();
$("#market-notes").addEventListener("input", event => {
  if (!signedInUser) { event.currentTarget.blur(); void requireActionSignIn(); return; }
  localStorage.setItem(marketNotesKey(), event.currentTarget.value);
  $("#market-notes-status").textContent = `Saved on this device · ${selected.replace("USDT", "/USDT")}`;
});
$("#market-notes").addEventListener("focus", async event => {
  if (!await requireActionSignIn()) event.currentTarget.blur();
});
$("#btn-clear-market-notes").addEventListener("click", async () => {
  if (!await requireActionSignIn()) return;
  localStorage.removeItem(marketNotesKey());
  $("#market-notes").value = "";
  $("#market-notes-status").textContent = "Note cleared.";
});

function chartViewportKey(symbol = selected) { return `${symbol}:${chartInterval}`; }

function applySavedChartViewport(options, symbol = selected) {
  if (chartViewport?.key !== chartViewportKey(symbol)) return;
  const { xMin, xMax, yMin, yMax } = chartViewport;
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite)) return;
  options.scales.x.min = xMin;
  options.scales.x.max = xMax;
  options.scales.y.min = yMin;
  options.scales.y.max = yMax;
}

// Keep only the requested compact shortcuts; users can search for any other market below.
const QUICK = ["SOL", "BTC", "ETH", "XRP", "BNB"];
const DEFAULT_WATCHLIST = QUICK.map(base => `${base}USDT`);
const PREVIOUS_EXPANDED_DEFAULT = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK", "AVAX", "DOT", "TRX", "LTC", "BCH", "SUI", "SHIB", "PEPE", "NEAR", "UNI", "APT", "ATOM", "ETC", "FIL", "ARB", "OP"].map(base => `${base}USDT`);
const PREVIOUS_COMPACT_DEFAULT = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK"].map(base => `${base}USDT`);
const WATCHLIST_KEY = "ai-trader-watchlist";
let localWatchlist = DEFAULT_WATCHLIST.slice();
renderMarketNotes();
let publicWatchlistPrices = {};
let publicWatchlistFetchedAt = 0;

function loadLocalWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "null");
    if (!Array.isArray(saved)) return DEFAULT_WATCHLIST;
    const cleaned = [...new Set(saved.filter(s => /^[A-Z0-9]{5,20}$/.test(s)))];
    // Shrink old auto-filled lists while retaining symbols visitors searched for themselves.
    const hadOldDefault = [PREVIOUS_EXPANDED_DEFAULT, PREVIOUS_COMPACT_DEFAULT]
      .some(oldList => oldList.every(s => cleaned.includes(s)));
    if (hadOldDefault) {
      const customMarkets = cleaned.filter(s => !PREVIOUS_EXPANDED_DEFAULT.includes(s));
      return [...DEFAULT_WATCHLIST, ...customMarkets].slice(0, 50);
    }
    return cleaned.slice(0, 50);
  } catch {
    return DEFAULT_WATCHLIST;
  }
}

function saveLocalWatchlist() {
  if (!signedInUser) return;
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(localWatchlist));
}

function readSavedIndicators() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDICATORS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((name, index) => INDICATOR_OPTIONS[name] && saved.indexOf(name) === index).slice(0, 3) : [];
  } catch { return []; }
}

function readSavedAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICE_ALERTS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(alert => alert && typeof alert.id === "string" && typeof alert.symbol === "string" && ["above", "below"].includes(alert.condition) && Number.isFinite(alert.target)) : [];
  } catch { return []; }
}

function syncDashboardPreferences(user) {
  if (!user) {
    selected = DEFAULT_WATCHLIST[0];
    chartStyle = "line";
    chartInterval = "1h";
    chartViewport = null;
    activeIndicators = [];
    priceAlerts = [];
    localWatchlist = DEFAULT_WATCHLIST.slice();
    chartDrawings = [];
    chartDrawingKey = "";
  } else {
    selected = localStorage.getItem("selected_symbol") || DEFAULT_WATCHLIST[0];
    chartStyle = localStorage.getItem("market-chart-style") === "candles" ? "candles" : "line";
    chartInterval = CHART_INTERVALS.includes(localStorage.getItem("market-chart-interval")) ? localStorage.getItem("market-chart-interval") : "1h";
    try { chartViewport = JSON.parse(localStorage.getItem(CHART_VIEW_STORAGE_KEY) || "null"); } catch { chartViewport = null; }
    activeIndicators = readSavedIndicators();
    priceAlerts = readSavedAlerts();
    localWatchlist = loadLocalWatchlist();
    if (!localWatchlist.includes(selected)) selected = localWatchlist[0] || DEFAULT_WATCHLIST[0];
  }
  $("#chart-style").value = chartStyle;
  $("#chart-interval").value = chartInterval;
  renderMarketNotes();
  renderPriceAlerts();
  renderIndicatorControls();
}

/* ------------------------------------------------------------------ helpers */
async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const authRequired = opts.authRequired ?? !["GET", "HEAD"].includes(method);
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const accessToken = await window.C4CAuth.getAccessToken();
  if (!accessToken && authRequired) {
    location.replace(`/login.html?returnTo=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`);
    throw new Error("Sign in is required.");
  }
  if (accessToken) opts.headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE_URL}${path}`, opts);
  if (res.status === 401 && authRequired) {
    location.replace(`/login.html?returnTo=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}&message=Your%20sign-in%20session%20expired.`);
    throw new Error("unauthorized");
  }
  if (opts.method === "POST" || opts.method === "DELETE") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || ("HTTP " + res.status));
    return data;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || ("HTTP " + res.status));
  return data;
}

const fmtUSD = (x, d) =>
  x == null || isNaN(x) ? "—" :
  "$" + Number(x).toLocaleString("en-US", {
    maximumFractionDigits: d ?? (Math.abs(x) >= 1000 ? 0 : 2),
    minimumFractionDigits: Math.abs(x) >= 1000 ? 0 : 2,
  });
const fmtMarketPrice = (x) => {
  const value = Math.abs(Number(x));
  return fmtUSD(x, value >= 100 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 10);
};
const fmtPct = (x) => (x == null || isNaN(x)) ? "—" : (x >= 0 ? "+" : "") + Number(x).toFixed(2) + "%";
const cls = (x) => (x >= 0 ? "up" : "down");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), 4000);
}

function sentTag(score) {
  const s = score == null ? 0 : score;
  const label = s > 0.12 ? "Bullish" : s < -0.12 ? "Bearish" : "Neutral";
  return `<span class="tag ${label.toLowerCase()}">${label}${s != null ? " " + (s >= 0 ? "+" : "") + s.toFixed(2) : ""}</span>`;
}

/* ------------------------------------------------------------------- status */
async function refreshStatus() {
  try {
    const st = await api("/api/status");
    $("#mode-badge").textContent = st.mode + (st.testnet && !st.dry_run ? " · TESTNET" : "");
    $("#mode-badge").className = "badge " + (st.dry_run ? "dry" : "live");
    const modeBanner = $("#mode-safety-banner");
    if (modeBanner) {
      modeBanner.hidden = false;
      if (st.dry_run) {
        modeBanner.className = "mode-safety-banner dry-run";
        modeBanner.textContent = "PAPER TRADING · DRY RUN — Orders are simulated; no real funds are used.";
      } else if (st.testnet) {
        modeBanner.className = "mode-safety-banner testnet";
        modeBanner.textContent = "TESTNET TRADING — Binance testnet funds only; verify settings before going live.";
      } else {
        modeBanner.className = "mode-safety-banner live-trading";
        modeBanner.textContent = "LIVE TRADING — Real orders and real funds are enabled. Review every setting carefully.";
      }
    }
    $("#bot-state").textContent = st.running ? "bot running" : "bot paused";
    $("#bot-state").className = "badge " + (st.running ? "on" : "off");
    $("#btn-bot").textContent = st.running ? "⏸ Pause bot" : "▶ Start bot";
    if (st.public) {
      $("#connections").innerHTML = '<span class="pill">Public market view · sign in for personal tools</span>';
      return;
    }
    let aiProviderInline = "";
    
    if (st.ai.llm_configured && st.ai.all_providers) {
      const providers = Object.entries(st.ai.all_providers);
      if (providers.length > 0) {
        const providerList = providers.map(([name, info]) => {
          const statusColor = {
            "healthy": "green",
            "slow": "orange", 
            "error": "red",
            "rate_limited": "orange",
            "unknown": "gray"
          }[info.status] || "gray";
          
          const indicator = info.status === "healthy" ? "✅" : (info.status === "error" ? "❌" : "⚠️");
          const isCurrent = st.ai.current_provider && st.ai.current_provider.name === name;
          const currentMark = isCurrent ? "★" : "";
          
          return `<span style="color: ${statusColor}; font-weight: 500;">${indicator} ${esc(name)}${currentMark ? `<span style="color: #fbbf24; margin-left: 2px;">${currentMark}</span>` : ""}</span>`;
        }).join(" • ");
        
        aiProviderInline = `🤖 ${providerList}`;
      }
    }
    
    $("#connections").innerHTML = `
      <span class="pill ${st.binance.configured ? "ok" : "bad"}">Binance: ${st.binance.configured ? (st.testnet ? "testnet keys" : "live keys") : "no keys (market data only)"}</span>
      <span class="pill ${st.telegram.configured && st.telegram.allowed_chats ? "ok" : "bad"}">Telegram: ${st.telegram.configured ? (st.telegram.allowed_chats ? "ready" : "no chat id") : "not set"}</span>
      <span class="pill ${st.ai.llm_configured ? "ok" : ""}">AI LLM: ${aiProviderInline || (st.ai.llm_configured ? "connected" : "built-in engine")}</span>
      <span class="pill">Spent today: ${fmtUSD(st.spent_today)} / ${fmtUSD(st.max_daily_usdt)}</span>`;
  } catch (e) { console.warn(e); }
}

/* -------------------------------------------------------------------- coins */
async function refreshCoins(forceMarket = false) {
  if (PUBLIC_DASHBOARD && (!authResolved || !signedInUser)) {
    await refreshPublicWatchlist(forceMarket);
    return;
  }
  let list;
  try { list = await api("/api/coins"); }
  catch (e) { await refreshPublicWatchlist(forceMarket); return; }
  coinsCache = {};
  for (const c of list) coinsCache[c.symbol] = c;

  const prevSelected = selected;
  if (!selected || !coinsCache[selected]) {
    selected = list[0]?.symbol || "";
    if (signedInUser) localStorage.setItem("selected_symbol", selected);
  }
  renderMarketNotes();
  $("#coins-list").innerHTML = list.length ? list.map(coinCard).join("") :
    '<div class="muted small">No coins yet — add one above.</div>';
  if (selected) {
    const c = coinsCache[selected];
    $("#sel-symbol").textContent = selected;
    $("#sel-price").innerHTML = `${fmtUSD(c.price, 2)} <span class="${cls(c.change_24h_pct)}" style="font-size:14px">${fmtPct(c.change_24h_pct)} 24h</span>`;
  } else {
    $("#sel-symbol").textContent = "—";
    $("#sel-price").textContent = "—";
  }
  if (selected && selected !== prevSelected) refreshForecast();
}

async function refreshPublicWatchlist(force = false) {
  const box = $("#coins-list");
  if (!localWatchlist.length) {
    box.innerHTML = '<div class="muted small">Your watchlist is empty. Add a USDT pair above.</div>';
    return;
  }

  if (force || Date.now() - publicWatchlistFetchedAt > 10000) {
    const endpoint = new URL("https://api.binance.com/api/v3/ticker/24hr");
    endpoint.searchParams.set("symbols", JSON.stringify(localWatchlist));
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
      const markets = await response.json();
      publicWatchlistPrices = Object.fromEntries(markets.map(m => [m.symbol, {
        price: Number(m.lastPrice), change_24h_pct: Number(m.priceChangePercent),
      }]));
      publicWatchlistFetchedAt = Date.now();
    } catch (e) {
      console.warn("watchlist market data:", e.message);
      if (!Object.keys(publicWatchlistPrices).length) {
        box.innerHTML = `<div class="muted small">Could not load watchlist prices: ${esc(e.message)}</div>`;
        return;
      }
    }
  }

  box.innerHTML = localWatchlist.map(symbol => {
    const market = publicWatchlistPrices[symbol];
    const base = symbol.slice(0, -4);
    return `<div class="coin-card watch-card ${symbol === selected ? "selected" : ""}" data-sym="${esc(symbol)}">
      <div class="coin-top"><b>${esc(base)} / USDT</b><span class="coin-price">${market ? fmtMarketPrice(market.price) : "—"}</span></div>
      <div class="coin-sub"><span class="${cls(market?.change_24h_pct ?? 0)}">${fmtPct(market?.change_24h_pct)} 24h</span>
        <button class="btn tiny" data-act="remove-watch" title="Remove ${esc(symbol)} from watchlist">Remove</button></div>
    </div>`;
  }).join("");
}

function coinCard(c) {
  const sel = c.symbol === selected ? "selected" : "";
  return `
  <div class="coin-card ${sel} ${c.enabled ? "" : "muted"}" data-sym="${c.symbol}">
    <div class="coin-top">
      <b>${c.symbol} ${c.enabled ? "" : "(off)"}</b>
      <span class="coin-top-right">
        <span class="coin-price">${fmtUSD(c.price)}</span>
        <button class="x-del" data-act="remove" title="Remove ${c.symbol} from watchlist">✕</button>
      </span>
    </div>
    <div class="coin-sub">
      <span class="${cls(c.change_24h_pct)}">${fmtPct(c.change_24h_pct)}</span>
      ${c.qty > 0 ? `<span>hold ${c.qty.toFixed(6)}</span><span class="${cls(c.pnl)}">${fmtUSD(c.pnl)} (${fmtPct(c.pnl_pct)})</span>` : `<span>no position</span>`}
    </div>
    <div class="coin-targets">
      <span>🟢 buy if ≤ ${fmtUSD(c.buy_target)} (−${c.buy_dip_pct}% from ${fmtUSD(c.anchor_price)})</span>
      <span>🔴 sell if ≥ ${fmtUSD(c.sell_target)} (+${c.sell_high_pct}% from cost ${fmtUSD(c.avg_cost)})</span>
    </div>
    <div class="coin-settings">
      <div class="row">
        <label>Dip buy %<input data-f="buy_dip_pct" type="number" step="0.5" value="${c.buy_dip_pct}"></label>
        <label>High sell %<input data-f="sell_high_pct" type="number" step="0.5" value="${c.sell_high_pct}"></label>
        <label>Order $<input data-f="trade_amount_usdt" type="number" step="5" value="${c.trade_amount_usdt}"></label>
      </div>
      <div class="btns">
        <button class="btn success tiny" data-act="save">Save</button>
        <button class="btn tiny" data-act="manual-buy">Buy now</button>
        <button class="btn tiny" data-act="manual-sell">Sell now</button>
        <button class="btn tiny" data-act="re-anchor">Re-anchor</button>
        <button class="btn tiny" data-act="toggle">${c.enabled ? "Disable" : "Enable"}</button>
        <button class="btn danger tiny" data-act="remove">Remove</button>
      </div>
    </div>
  </div>`;
}

$("#coins-list")?.addEventListener("click", async (ev) => {
  const card = ev.target.closest(".coin-card");
  if (!card) return;
  const sym = card.dataset.sym;
  const act = ev.target.dataset.act;

  if (!act) { // open settings / select
    if (selected !== sym) { selected = sym; if (signedInUser) localStorage.setItem("selected_symbol", sym); renderMarketNotes(); refreshCoins(); refreshForecast(); }
    else card.classList.toggle("open");
    return;
  }
  try {
    if (act === "remove-watch") {
      if (!await requireActionSignIn()) return;
      localWatchlist = localWatchlist.filter(symbol => symbol !== sym);
      saveLocalWatchlist();
      if (selected === sym) {
        selected = localWatchlist[0] || "";
        if (signedInUser) localStorage.setItem("selected_symbol", selected);
        renderMarketNotes();
      }
      await refreshPublicWatchlist(true);
      if (selected) await refreshForecast();
      else {
        $("#sel-symbol").textContent = "—";
        $("#sel-price").textContent = "—";
        setChartMessage("Add a coin to load its live market chart.");
      }
      toast(`${sym} removed from watchlist`);
    } else if (act === "save") {
      if (!await requireActionSignIn()) return;
      const fields = {};
      card.querySelectorAll("input[data-f]").forEach(i => fields[i.dataset.f] = parseFloat(i.value));
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify(fields) });
      toast(`${sym} settings saved`);
    } else if (act === "manual-buy" || act === "manual-sell") {
      if (!await requireActionSignIn()) return;
      await api("/api/manual-trade", { method: "POST", body: JSON.stringify({ symbol: sym, side: act === "manual-buy" ? "BUY" : "SELL" }) });
      toast(`${act === "manual-buy" ? "Buy" : "Sell"} signal created for ${sym} — check pending/Telegram`);
    } else if (act === "re-anchor") {
      if (!await requireActionSignIn()) return;
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify({ reset_anchor: true }) });
      toast(`${sym} will re-anchor to current price on next check`);
    } else if (act === "toggle") {
      if (!await requireActionSignIn()) return;
      const en = coinsCache[sym]?.enabled;
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify({ enabled: !en }) });
    } else if (act === "remove") {
      if (!await requireActionSignIn()) return;
      if (!confirm(`Remove ${sym}? (positions info is removed too, funds stay on Binance)`)) return;
      await api(`/api/coins/${sym}`, { method: "DELETE" });
      toast(`${sym} removed`);
    }
    await refreshCoins();
  } catch (e) { toast(e.message, true); }
});

async function addCoin(sym) {
  if (!await requireActionSignIn()) return;
  const input = String(sym).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = ({ SOLANA: "SOL", BITCOIN: "BTC", ETHEREUM: "ETH" })[input.replace(/USDT$/, "")] || input.replace(/USDT$/, "");
  const symbol = `${base}USDT`;
  try {
    const r = await api("/api/coins", { method: "POST", body: JSON.stringify({ symbol }) });
    toast(`${r.symbol} added — anchored at ${fmtUSD(r.anchor_price)}`);
    $("#new-symbol").value = "";
    await refreshCoins();
  } catch (e) {
    if (/HTTP (?:404|405)\b/.test(e.message)) {
      if (!localWatchlist.includes(symbol)) {
        const check = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
        if (!check.ok) { toast(`${symbol} is not an available Binance USDT market`, true); return; }
        localWatchlist = [...localWatchlist, symbol].slice(-50);
        saveLocalWatchlist();
      }
      selected = symbol;
      if (signedInUser) localStorage.setItem("selected_symbol", selected);
      renderMarketNotes();
      await refreshPublicWatchlist(true);
      await refreshForecast();
      toast(`${symbol} selected for the live chart`);
      return;
    }
    toast(e.message, true);
  }
}
$("#btn-add").addEventListener("click", () => { const v = $("#new-symbol").value.trim(); if (v) addCoin(v); });
$("#new-symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add").click(); });
$("#quick-add").innerHTML = QUICK.map(s => `<button data-s="${s}">${s}/USDT</button>`).join("");
$("#quick-add").addEventListener("click", (e) => { if (e.target.dataset.s) addCoin(e.target.dataset.s); });

/* --------------------------------------------------------------------- wallet */
async function refreshWallet() {
  try {
    const wallet = await api("/api/wallet");
    const box = $("#wallet-box");
    
    if (wallet.error) {
      box.innerHTML = `<span class="muted small">Error: ${esc(wallet.error)}</span>`;
      return;
    }
    
    const totalPnl = wallet.total_pnl || 0;
    const pnlClass = totalPnl >= 0 ? "up" : "down";
    const pnlIcon = totalPnl >= 0 ? "📈" : "📉";
    
    let positionsHtml = "";
    if (wallet.positions && wallet.positions.length > 0) {
      positionsHtml = wallet.positions.map(pos => {
        const posPnlClass = pos.pnl >= 0 ? "up" : "down";
        const posPnlIcon = pos.pnl >= 0 ? "📈" : "📉";
        const openedTime = pos.position_opened ? new Date(pos.position_opened).toLocaleString() : 'N/A';
        return `
          <div class="wallet-position" style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size: 12px;">
            <div style="display: flex; justify-content: space-between;">
              <span><b>${esc(pos.symbol)}</b></span>
              <span class="${posPnlClass}">${posPnlIcon} ${pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)} (${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}%)</span>
            </div>
            <div class="muted">Qty: ${pos.qty.toFixed(6)} @ ${pos.avg_cost.toFixed(2)} → Current: ${pos.current_price.toFixed(2)}</div>
            <div class="muted">Value: ${fmtUSD(pos.position_value)} | Invested: ${fmtUSD(pos.invested)}</div>
            <div class="muted small" style="margin-top: 4px;">Position opened: ${openedTime}</div>
          </div>
        `;
      }).join("");
    }
    
    box.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
        <div style="background: rgba(34, 197, 94, 0.1); padding: 8px; border-radius: 6px; text-align: center;">
          <div class="muted small">USDT Balance</div>
          <div style="font-size: 16px; font-weight: 600; color: var(--green);">${fmtUSD(wallet.usdt_balance)}</div>
        </div>
        <div style="background: rgba(59, 130, 246, 0.1); padding: 8px; border-radius: 6px; text-align: center;">
          <div class="muted small">Positions</div>
          <div style="font-size: 16px; font-weight: 600; color: var(--blue);">${fmtUSD(wallet.positions_value)}</div>
        </div>
      </div>
      <div style="background: rgba(168, 85, 247, 0.1); padding: 8px; border-radius: 6px; text-align: center; margin-bottom: 8px;">
        <div class="muted small">Total Wallet Value</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--purple);">${fmtUSD(wallet.total_wallet_value)}</div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span class="muted">Total P&L:</span>
        <span class="${pnlClass}" style="font-weight: 600;">${pnlIcon} ${totalPnl >= 0 ? '+' : ''}${fmtUSD(totalPnl)}</span>
      </div>
      <div class="muted small">Spent today: ${fmtUSD(wallet.spent_today)} / ${fmtUSD(wallet.max_daily_usdt)}</div>
      <div class="muted small" style="margin-top: 4px;">Last updated: ${wallet.last_updated ? new Date(wallet.last_updated).toLocaleString() : 'N/A'}</div>
      ${positionsHtml}
    `;
  } catch (e) {
    console.warn("wallet:", e.message);
    $("#wallet-box").innerHTML = `<span class="muted small">Error loading wallet</span>`;
  }
}

/* ----------------------------------------------------------------- forecast */
async function refreshForecast(refreshExtras = true) {
  if (!selected) {
    setChartMessage("Add a coin to load its live market chart.");
    return;
  }
  const symbol = selected;
  renderPriceAlerts();
  if (!chart) setChartMessage("Loading live market chart…");
  if (PUBLIC_DASHBOARD && (!authResolved || !signedInUser)) {
    try { await renderPublicMarketChart(symbol); }
    catch (e) { setChartMessage(`Chart unavailable: ${e.message}`); }
    return;
  }
  if (chartStyle === "candles" || chartInterval !== "1h") {
    try { await renderPublicMarketChart(symbol); }
    catch (e) { setChartMessage(`Chart unavailable: ${e.message}`); }
    return;
  }
  try {
    if (forecastApiUnavailable) throw new Error("HTTP 404");
    const f = await api(`/api/forecast/${symbol}`);
    if (symbol !== selected) return;
    forecastCache = f;
    renderForecast(f);
    renderChart(f);
    renderIndicatorReadouts((f.history_closes || []).map(close => ({ close })));
    await refreshSupertrendDashboard(symbol);
  } catch (e) {
    console.warn("forecast:", e.message);
    if (symbol === selected) {
      if (/HTTP (?:404|405)\b/.test(e.message)) forecastApiUnavailable = true;
      try {
        await renderPublicMarketChart(symbol);
      } catch (marketError) {
        setChartMessage(`Chart unavailable: ${marketError.message}`);
      }
    }
  }
  if (refreshExtras) {
    refreshAdvice();
    refreshAIStatus();
  }
}

async function refreshAIStatus() {
  const box = $("#ai-status-box");
  try {
    const status = await api("/api/ai-status");
    let html = "";
    
    for (const [name, info] of Object.entries(status)) {
      const statusColor = {
        "healthy": "green",
        "slow": "orange", 
        "error": "red",
        "rate_limited": "orange",
        "unknown": "gray"
      }[info.status] || "gray";
      
      const responseTime = info.response_time_ms ? `${info.response_time_ms.toFixed(0)}ms` : "N/A";
      const successRate = info.stats?.success_rate ? `${info.stats.success_rate}%` : "N/A";
      const hasKey = info.has_api_key;
      const keyStatus = hasKey ? "✅ API Key" : "⚠️ No API Key";
      const keyColor = hasKey ? "green" : "orange";
      
      html += `
        <div class="ai-provider-card">
          <div class="ai-provider-header">
            <span class="ai-provider-name">${esc(name)}</span>
            <span class="ai-provider-status" style="color: ${statusColor}">${esc(info.status.toUpperCase())}</span>
            <span class="ai-provider-key" style="color: ${keyColor}">${keyStatus}</span>
          </div>
          <div class="ai-provider-details">
            <div><span class="muted">Model:</span> ${esc(info.model)}</div>
            <div><span class="muted">Response:</span> ${responseTime}</div>
            <div><span class="muted">Success:</span> ${successRate} (${info.success_count}/${info.failure_count})</div>
            ${info.error_message ? `<div class="ai-error">${esc(info.error_message)}</div>` : ""}
          </div>
        </div>
      `;
    }
    
    box.innerHTML = html || '<span class="muted small">No AI providers configured</span>';
  } catch (e) {
    box.innerHTML = `<span class="muted small">Error: ${esc(e.message)}</span>`;
  }
}

async function refreshAdvice() {
  if (!selected) return;
  const box = $("#advice-box");
  try {
    const a = await api(`/api/advice/${selected}`);
    const clsMap = { BUY: "adv-buy", SELL: "adv-sell", HOLD: "adv-hold" };
    const factors = (a.factors || []).map(fc => `
      <div class="adv-factor">
        <span class="tag ${fc.view?.startsWith("bullish") ? "bullish" : fc.view?.startsWith("bearish") ? "bearish" : "neutral"}">${esc(fc.factor)}</span>
        <span class="muted small">${esc(fc.detail || fc.view || "")}</span>
      </div>`).join("");
    box.innerHTML = `
      <div class="adv-head">
        <span class="adv-badge ${clsMap[a.action] || "adv-hold"}">${a.action}</span>
        <span class="muted small">${Math.round((a.confidence || 0) * 100)}% confidence · ${esc(a.engine === "llm" ? "LLM analysis" : "rule-based")} · ${esc(a.generated_at || "")}</span>
      </div>
      <div class="adv-summary">${esc(a.summary || "")}</div>
      ${factors}
      ${a.note ? `<div class="muted small" style="margin-top:6px">⚠ ${esc(a.note)}</div>` : ""}`;
  } catch (e) {
    box.innerHTML = `<span class="muted small">advisor: ${esc(e.message)}</span>`;
  }
}

function renderForecast(f) {
  const ind = f.indicators || {};
  $("#forecast-chips").innerHTML = `
    <span class="chip trend-${f.trend}">Trend: <b>${f.trend}</b></span>
    <span class="chip">RSI: <b>${ind.rsi?.toFixed(1)}</b></span>
    <span class="chip">MACD: <b>${ind.macd > ind.macd_signal ? "bullish" : "bearish"}</b></span>
    <span class="chip">24h vol: <b>${ind.daily_volatility_pct?.toFixed(1) ?? "—"}%</b></span>`;
  $("#forecast-grid").innerHTML = `
    <div class="fcell"><div class="k">Predicted low (24h)</div><div class="v down">${fmtUSD(f.predicted_low)}</div><div class="s">5th percentile of 2,000 simulated paths</div></div>
    <div class="fcell"><div class="k">Predicted high (24h)</div><div class="v up">${fmtUSD(f.predicted_high)}</div><div class="s">95th percentile of 2,000 simulated paths</div></div>
    <div class="fcell"><div class="k">Median in 24h</div><div class="v">${fmtUSD(f.median_24h)}</div><div class="s">${fmtPct((f.median_24h / f.last_close - 1) * 100)} from now</div></div>
    <div class="fcell"><div class="k">Now</div><div class="v">${fmtUSD(f.last_close)}</div><div class="s">EMA20 ${fmtUSD(ind.ema20)} · EMA50 ${fmtUSD(ind.ema50)}</div></div>`;
}

function renderIndicatorControls() {
  const select = $("#indicator-select");
  const addButton = $("#btn-add-indicator");
  const available = Object.keys(INDICATOR_OPTIONS).filter(name => !activeIndicators.includes(name));
  if (!available.includes(select.value)) select.value = available[0] || "";
  const atLimit = activeIndicators.length >= 3;
  select.querySelectorAll("option").forEach(option => {
    option.disabled = !option.value || atLimit || activeIndicators.includes(option.value);
  });
  $("#indicator-count").textContent = `(${activeIndicators.length}/3 selected)`;
  select.disabled = atLimit || available.length === 0;
  addButton.disabled = atLimit || !INDICATOR_OPTIONS[select.value] || activeIndicators.includes(select.value);
  addButton.textContent = atLimit ? "Maximum selected" : "Add indicator";
  $("#active-indicators").innerHTML = activeIndicators.length
    ? activeIndicators.map(name => `<span class="indicator-pill">${esc(INDICATOR_OPTIONS[name])}<button type="button" data-remove-indicator="${name}" aria-label="Remove ${esc(INDICATOR_OPTIONS[name])}" title="Remove indicator">×</button></span>`).join("")
    : '<span class="muted small">No indicators selected.</span>';
  $("#supertrend-dashboard").hidden = !activeIndicators.includes("supertrend");
}

function ema(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  return values.reduce((result, value, index) => {
    result.push(index ? value * multiplier + result[index - 1] * (1 - multiplier) : value);
    return result;
  }, []);
}

function buildSupertrendOverlay(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return [];
  const trueRanges = candles.map((candle, index) => {
    if (!index) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const atr = Array(candles.length).fill(null);
  atr[period - 1] = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < candles.length; index++) {
    atr[index] = (atr[index - 1] * (period - 1) + trueRanges[index]) / period;
  }
  const bullish = Array(candles.length).fill(null);
  const bearish = Array(candles.length).fill(null);
  let upperBand = null, lowerBand = null, direction = null;
  for (let index = period - 1; index < candles.length; index++) {
    const candle = candles[index];
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + multiplier * atr[index];
    const basicLower = midpoint - multiplier * atr[index];
    const previousClose = candles[index - 1]?.close ?? candle.close;
    const nextUpper = upperBand == null || basicUpper < upperBand || previousClose > upperBand ? basicUpper : upperBand;
    const nextLower = lowerBand == null || basicLower > lowerBand || previousClose < lowerBand ? basicLower : lowerBand;
    if (direction == null) direction = candle.close >= midpoint ? "bullish" : "bearish";
    else if (direction === "bearish" && candle.close > nextUpper) direction = "bullish";
    else if (direction === "bullish" && candle.close < nextLower) direction = "bearish";
    if (direction === "bullish") bullish[index] = nextLower;
    else bearish[index] = nextUpper;
    upperBand = nextUpper;
    lowerBand = nextLower;
  }
  return [
    { label: "Supertrend bullish", data: bullish, borderColor: "#22c55e", borderWidth: 1.5, pointRadius: 0, tension: 0, spanGaps: false },
    { label: "Supertrend bearish", data: bearish, borderColor: "#ef4444", borderWidth: 1.5, pointRadius: 0, tension: 0, spanGaps: false },
  ];
}

function buildPriceIndicatorOverlays(candles, closes) {
  const overlays = [];
  if (activeIndicators.includes("ema")) {
    overlays.push(
      { label: "EMA 20", data: ema(closes, 20), borderColor: "#f59e0b", borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: "EMA 50", data: ema(closes, 50), borderColor: "#a855f7", borderWidth: 1.5, pointRadius: 0, tension: 0 },
    );
  }
  if (activeIndicators.includes("bollinger") && closes.length >= 20) {
    const upper = Array(closes.length).fill(null);
    const middle = Array(closes.length).fill(null);
    const lower = Array(closes.length).fill(null);
    for (let index = 19; index < closes.length; index++) {
      const sample = closes.slice(index - 19, index + 1);
      const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
      const deviation = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length);
      middle[index] = mean;
      upper[index] = mean + 2 * deviation;
      lower[index] = mean - 2 * deviation;
    }
    overlays.push(
      { label: "Bollinger upper", data: upper, borderColor: "rgba(56,189,248,.8)", borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0 },
      { label: "Bollinger middle", data: middle, borderColor: "rgba(56,189,248,.55)", borderWidth: 1, pointRadius: 0, tension: 0 },
      { label: "Bollinger lower", data: lower, borderColor: "rgba(56,189,248,.8)", borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0 },
    );
  }
  if (activeIndicators.includes("supertrend")) overlays.push(...buildSupertrendOverlay(candles));
  return overlays;
}

function renderIndicatorReadouts(candles) {
  const selectedReadouts = activeIndicators.filter(name => name !== "supertrend");
  if (!selectedReadouts.length) {
    $("#indicator-readouts").innerHTML = "";
    return;
  }
  if (!candles?.length) {
    $("#indicator-readouts").innerHTML = '<span class="muted small">Select a market to load indicator values.</span>';
    return;
  }
  const closes = candles.map(candle => candle.close);
  const readouts = selectedReadouts.map(name => {
    if (name === "rsi") {
      if (closes.length < 15) return `<div class="indicator-readout"><b>RSI (14)</b><span>Waiting for more candles</span></div>`;
      const changes = closes.slice(-15).slice(1).map((close, i) => close - closes.slice(-15)[i]);
      const gains = changes.reduce((sum, change) => sum + Math.max(change, 0), 0) / 14;
      const losses = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0) / 14;
      const rsi = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses);
      const signal = rsi >= 70 ? "Overbought" : rsi <= 30 ? "Oversold" : "Neutral";
      return `<div class="indicator-readout"><b>Relative Strength Index (RSI 14)</b><span>${rsi.toFixed(1)} · ${signal}</span></div>`;
    }
    if (name === "macd") {
      const fast = ema(closes, 12), slow = ema(closes, 26);
      const macdLine = fast.map((value, i) => value - slow[i]);
      const signalLine = ema(macdLine, 9);
      const current = macdLine.at(-1), signal = signalLine.at(-1);
      const trend = current >= signal ? "Bullish" : "Bearish";
      return `<div class="indicator-readout"><b>MACD (12, 26, 9)</b><span>${trend} · ${fmtMarketPrice(current - signal)}</span></div>`;
    }
    if (name === "ema") {
      const fast = ema(closes, 20).at(-1), slow = ema(closes, 50).at(-1);
      const trend = fast >= slow ? "Bullish crossover" : "Bearish crossover";
      return `<div class="indicator-readout"><b>EMA (20 / 50)</b><span>${trend} · ${fmtMarketPrice(fast)} / ${fmtMarketPrice(slow)}</span></div>`;
    }
    if (name === "bollinger") {
      const window = closes.slice(-20);
      const middle = window.reduce((sum, value) => sum + value, 0) / window.length;
      const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / window.length);
      const upper = middle + 2 * deviation, lower = middle - 2 * deviation;
      const position = closes.at(-1) > upper ? "Above upper band" : closes.at(-1) < lower ? "Below lower band" : "Within bands";
      return `<div class="indicator-readout"><b>Bollinger Bands (20, 2)</b><span>${position} · ${fmtMarketPrice(lower)}–${fmtMarketPrice(upper)}</span></div>`;
    }
    if (candles.length < 15) return `<div class="indicator-readout"><b>ATR (14)</b><span>Waiting for more candles</span></div>`;
    const ranges = candles.slice(-14).map((candle, index, sample) => {
      const previous = index ? sample[index - 1].close : candles.at(-15).close;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
    });
    const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
    return `<div class="indicator-readout"><b>Average True Range (ATR 14)</b><span>${fmtMarketPrice(atr)} · ${((atr / closes.at(-1)) * 100).toFixed(2)}% volatility</span></div>`;
  });
  $("#indicator-readouts").innerHTML = readouts.join("");
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return null;
  const trueRanges = candles.map((candle, i) => {
    if (!i) return candle.high - candle.low;
    const previousClose = candles[i - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const atr = Array(candles.length).fill(null);
  atr[period - 1] = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trueRanges[i]) / period;
  }

  let upperBand = null, lowerBand = null, direction = null;
  for (let i = period - 1; i < candles.length; i++) {
    const midpoint = (candles[i].high + candles[i].low) / 2;
    const basicUpper = midpoint + multiplier * atr[i];
    const basicLower = midpoint - multiplier * atr[i];
    const previousClose = i ? candles[i - 1].close : candles[i].close;
    const nextUpper = upperBand == null || basicUpper < upperBand || previousClose > upperBand ? basicUpper : upperBand;
    const nextLower = lowerBand == null || basicLower > lowerBand || previousClose < lowerBand ? basicLower : lowerBand;
    if (direction == null) direction = candles[i].close >= midpoint ? "Bullish" : "Bearish";
    else if (direction === "Bearish" && candles[i].close > nextUpper) direction = "Bullish";
    else if (direction === "Bullish" && candles[i].close < nextLower) direction = "Bearish";
    upperBand = nextUpper;
    lowerBand = nextLower;
  }
  return direction;
}

function renderSupertrendDashboard(results) {
  const intervals = ["15m", "30m", "1h", "4h"];
  const headings = intervals.map(interval => `<th scope="col">${interval}</th>`).join("");
  const states = intervals.map(interval => {
    const state = results[interval];
    const label = state === "Bullish" || state === "Bearish" ? state : state || "Unavailable";
    const css = state === "Bullish" ? "bullish" : state === "Bearish" ? "bearish" : "unavailable";
    return `<td><span class="supertrend-state ${css}">${label}</span></td>`;
  }).join("");
  $("#supertrend-dashboard").innerHTML = `<table aria-label="Multi-timeframe Supertrend dashboard">
    <caption>Multi-timeframe Supertrend · ATR 10 / factor 3</caption>
    <thead><tr>${headings}</tr></thead><tbody><tr>${states}</tr></tbody></table>`;
}

async function fetchBinanceCandles(symbol, interval, limit = 168) {
  const endpoint = new URL("https://api.binance.com/api/v3/klines");
  endpoint.search = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
  const values = await response.json();
  return values.map(candle => ({
    time: Number(candle[0]), open: Number(candle[1]), high: Number(candle[2]),
    low: Number(candle[3]), close: Number(candle[4]),
  }));
}

async function refreshSupertrendDashboard(symbol, existing = {}) {
  if (!activeIndicators.includes("supertrend")) {
    $("#supertrend-dashboard").innerHTML = "";
    return;
  }
  const intervals = ["15m", "30m", "1h", "4h"];
  const settled = await Promise.allSettled(intervals.map(async interval => {
    const candles = existing[interval] || await fetchBinanceCandles(symbol, interval, 120);
    return [interval, calculateSupertrend(candles) || "Unavailable"];
  }));
  if (symbol !== selected) return;
  const results = Object.fromEntries(settled.map((result, index) => [
    intervals[index], result.status === "fulfilled" ? result.value[1] : "Unavailable",
  ]));
  renderSupertrendDashboard(results);
}

function renderChart(f) {
  if (!window.Chart) {
    setChartMessage("Chart library did not load. Check your connection and reload.");
    return;
  }
  const H = f.history_closes.length;
  const labels = [...f.history_times, ...f.forecast_times].map(ms =>
    new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit" }));
  const filler = (arr, off) => labels.map((_, i) => (i >= off && i < off + arr.length) ? arr[i - off] : null);
  const flat = (val, off) => labels.map((_, i) => (i >= off ? val : null));
  const coin = coinsCache[selected] || {};

  const ds = [
    { label: "Price 7d", data: [...f.history_closes, ...Array(f.forecast_times.length).fill(null)],
      borderColor: "#3b82f6", borderWidth: 2, pointRadius: 0, tension: 0.2 },
    { label: "AI median path", data: filler(f.median_path, H),
      borderColor: "#a855f7", borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.3 },
    { label: "95% band high", data: filler(f.band_high, H),
      borderColor: "rgba(168,85,247,.35)", borderWidth: 1, pointRadius: 0 },
    { label: "95% band low", data: filler(f.band_low, H),
      borderColor: "rgba(168,85,247,.35)", borderWidth: 1, pointRadius: 0,
      backgroundColor: "rgba(168,85,247,.12)", fill: "-1" },
    { label: "Predicted high", data: flat(f.predicted_high, H),
      borderColor: "#f59e0b", borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0 },
    { label: "Predicted low", data: flat(f.predicted_low, H),
      borderColor: "#06b6d4", borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0 },
  ];
  if (coin.buy_target) ds.push({ label: "Buy trigger", data: labels.map(() => coin.buy_target),
    borderColor: "rgba(34,197,94,.8)", borderDash: [8, 6], borderWidth: 1.5, pointRadius: 0 });
  if (coin.sell_target) ds.push({ label: "Sell trigger", data: labels.map(() => coin.sell_target),
    borderColor: "rgba(239,68,68,.8)", borderDash: [8, 6], borderWidth: 1.5, pointRadius: 0 });

  const cfg = {
    type: "line",
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { color: "#8b95a7", boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtUSD(c.parsed.y, 2)}` } } },
      scales: {
        x: { ticks: { color: "#8b95a7", maxTicksLimit: 10, font: { size: 10 } }, grid: { color: "#17202f" } },
        y: { ticks: { color: "#8b95a7", font: { size: 10 }, callback: (v) => "$" + Number(v).toLocaleString() }, grid: { color: "#17202f" } },
      },
    },
  };
  applySavedChartViewport(cfg.options, selected);
  chartDrawings = loadChartDrawings(selected);
  updateHiddenDrawingButton();
  if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update("none"); }
  else chart = new Chart($("#chart"), cfg);
  chart.$publicCandles = null;
  chart.$marketCandles = null;
  chart.$historyCandleIndex = H - 1;
  chart.$historyCandleOpenTime = Number(f.history_times?.at(-1));
  chart.$historyIntervalMs = ({ "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 })[chartInterval] || 3600000;
  chart.$historyPreviousClose = f.history_closes.at(-2);
  chart.$indicatorCandles = (f.history_closes || []).map(close => ({ close }));
  chart.$chartBounds = {
    xMin: 0, xMax: labels.length - 1,
    yMin: Math.min(...f.history_closes), yMax: Math.max(...f.history_closes),
  };
  $("#market-updated").textContent = `Live price: every second · candles refresh each minute`;
  startMarketStream(selected, chartInterval);
  setChartMessage("");
}

const candlestickOverlay = {
  id: "marketCandlesticks",
  beforeDatasetsDraw(chartInstance) {
    const candles = chartInstance.$marketCandles;
    if (!candles?.length) return;
    const { ctx, scales: { x, y } } = chartInstance;
    const candleWidth = Math.max(2, Math.min(12, (x.width / candles.length) * 0.58));
    ctx.save();
    candles.forEach((candle, index) => {
      const center = x.getPixelForValue(index);
      const rising = candle.close >= candle.open;
      const color = rising ? "#22c55e" : "#ef4444";
      const openY = y.getPixelForValue(candle.open);
      const closeY = y.getPixelForValue(candle.close);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(center, y.getPixelForValue(candle.high));
      ctx.lineTo(center, y.getPixelForValue(candle.low));
      ctx.stroke();
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(center - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });
    ctx.restore();
  },
};
const chartDrawingOverlay = {
  id: "userMarketDrawings",
  afterDatasetsDraw(chartInstance) {
    if (!chartDrawings.length) return;
    const { ctx, chartArea, scales: { x, y } } = chartInstance;
    if (!chartArea || !x || !y) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();
    ctx.strokeStyle = "#fbbf24";
    ctx.fillStyle = "#fbbf24";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    chartDrawings.forEach(line => {
      if (line.hidden) return;
      const lineColor = /^#[0-9a-f]{6}$/i.test(line.color || "") ? line.color : "#fbbf24";
      ctx.strokeStyle = lineColor;
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      if (line.type === "horizontal") {
        const pixel = y.getPixelForValue(line.price);
        ctx.moveTo(chartArea.left, pixel);
        ctx.lineTo(chartArea.right, pixel);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "10px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(fmtMarketPrice(line.price), chartArea.right - 5, pixel - 4);
        ctx.setLineDash([5, 4]);
      } else if (line.type === "vertical") {
        const pixel = x.getPixelForValue(line.index);
        ctx.moveTo(pixel, chartArea.top);
        ctx.lineTo(pixel, chartArea.bottom);
        ctx.stroke();
      } else if (line.type === "freehand" && line.points?.length > 1) {
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        line.points.forEach((point, index) => {
          const px = x.getPixelForValue(point.index);
          const py = y.getPixelForValue(point.price);
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 4]);
      } else if (line.type === "text") {
        const px = x.getPixelForValue(line.index);
        const py = y.getPixelForValue(line.price);
        ctx.setLineDash([]);
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const lines = line.text.split("\n").slice(0, 4);
        lines.forEach((text, index) => ctx.fillText(text.slice(0, 80), px + 5, py + 5 + index * 15, 220));
        ctx.setLineDash([5, 4]);
      }
    });
    ctx.restore();
  },
};
if (window.Chart) Chart.register(candlestickOverlay, chartDrawingOverlay);

function saveChartViewport() {
  if (!signedInUser) return;
  if (!chart?.scales?.x || !chart?.scales?.y) return;
  chartViewport = {
    key: chartViewportKey(),
    xMin: chart.scales.x.min, xMax: chart.scales.x.max,
    yMin: chart.scales.y.min, yMax: chart.scales.y.max,
  };
  localStorage.setItem(CHART_VIEW_STORAGE_KEY, JSON.stringify(chartViewport));
}

function panChartByPixels(dx, dy, persist = true) {
  if (!chart?.chartArea || !chart.scales?.x || !chart.scales?.y) return;
  const x = chart.scales.x;
  const y = chart.scales.y;
  const xRange = x.max - x.min;
  const yRange = y.max - y.min;
  const bounds = chart.$chartBounds || { xMin: 0, xMax: chart.data.labels.length - 1 };
  let xMin = x.min - dx / chart.chartArea.width * xRange;
  let xMax = xMin + xRange;
  if (Number.isFinite(bounds.xMin) && Number.isFinite(bounds.xMax)) {
    xMin = Math.max(bounds.xMin, Math.min(xMin, bounds.xMax - xRange));
    xMax = xMin + xRange;
  }
  const yShift = dy / chart.chartArea.height * yRange;
  chart.options.scales.x.min = xMin;
  chart.options.scales.x.max = xMax;
  chart.options.scales.y.min = y.min + yShift;
  chart.options.scales.y.max = y.max + yShift;
  chart.update("none");
  if (persist) saveChartViewport();
}

function zoomChart(direction) {
  if (!chart?.scales?.x || !chart.scales?.y) return;
  const x = chart.scales.x;
  const y = chart.scales.y;
  const bounds = chart.$chartBounds || {};
  const xBaseRange = Math.max(1, (bounds.xMax ?? x.max) - (bounds.xMin ?? x.min));
  const yBaseRange = Math.max(Number.EPSILON, (bounds.yMax ?? y.max) - (bounds.yMin ?? y.min));
  const factor = direction === "in" ? 0.8 : 1.25;
  const xRange = Math.min(xBaseRange, Math.max(Math.min(6, xBaseRange), (x.max - x.min) * factor));
  const yRange = Math.min(yBaseRange * 5, Math.max(yBaseRange * 0.01, (y.max - y.min) * factor));
  const xCenter = (x.min + x.max) / 2;
  const yCenter = (y.min + y.max) / 2;
  let xMin = xCenter - xRange / 2;
  if (Number.isFinite(bounds.xMin) && Number.isFinite(bounds.xMax)) {
    xMin = Math.max(bounds.xMin, Math.min(xMin, bounds.xMax - xRange));
  }
  chart.options.scales.x.min = xMin;
  chart.options.scales.x.max = xMin + xRange;
  chart.options.scales.y.min = yCenter - yRange / 2;
  chart.options.scales.y.max = yCenter + yRange / 2;
  chart.update("none");
  saveChartViewport();
}

function resetChartViewport() {
  chartViewport = null;
  localStorage.removeItem(CHART_VIEW_STORAGE_KEY);
  if (!chart) return;
  for (const axis of ["x", "y"]) {
    delete chart.options.scales[axis].min;
    delete chart.options.scales[axis].max;
  }
  chart.update("none");
}

document.querySelector(".chart-navigation-tools").addEventListener("click", event => {
  const button = event.target.closest("[data-chart-nav]");
  if (!button) return;
  const action = button.dataset.chartNav;
  if (action === "reset") { resetChartViewport(); return; }
  if (action === "zoom-in" || action === "zoom-out") {
    zoomChart(action === "zoom-in" ? "in" : "out");
    return;
  }
  if (!chart?.chartArea) return;
  const { width, height } = chart.chartArea;
  const panDistance = 0.15;
  const offsets = {
    left: [-width * panDistance, 0], right: [width * panDistance, 0],
    up: [0, -height * panDistance], down: [0, height * panDistance],
  }[action];
  if (offsets) panChartByPixels(...offsets);
});

let chartDrag = null;
let activeFreehand = null;
let contextDrawingIndex = -1;
function drawingPointFromPointer(event) {
  if (!chart?.chartArea) return null;
  const rect = chart.canvas.getBoundingClientRect();
  const xPixel = (event.clientX - rect.left) * (chart.width / rect.width);
  const yPixel = (event.clientY - rect.top) * (chart.height / rect.height);
  const area = chart.chartArea;
  if (xPixel < area.left || xPixel > area.right || yPixel < area.top || yPixel > area.bottom) return null;
  return { index: chart.scales.x.getValueForPixel(xPixel), price: chart.scales.y.getValueForPixel(yPixel), xPixel, yPixel };
}
$("#chart").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  if (drawingTool === "freehand") {
    if (!signedInUser) { void requireActionSignIn(); return; }
    const point = drawingPointFromPointer(event);
    if (!point) return;
    chartDrawings.push({ type: "freehand", points: [{ index: point.index, price: point.price }] });
    activeFreehand = { drawing: chartDrawings.at(-1), pointerId: event.pointerId, lastX: point.xPixel, lastY: point.yPixel };
    event.currentTarget.setPointerCapture(event.pointerId);
    chart.update("none");
    return;
  }
  if (event.pointerType !== "mouse") return;
  if (drawingTool || !chart?.chartArea) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (chart.width / rect.width);
  const y = (event.clientY - rect.top) * (chart.height / rect.height);
  const area = chart.chartArea;
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
  chartDrag = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  event.currentTarget.setPointerCapture(event.pointerId);
});
$("#chart").addEventListener("pointermove", event => {
  if (activeFreehand?.pointerId === event.pointerId) {
    const point = drawingPointFromPointer(event);
    if (!point) return;
    if (Math.hypot(point.xPixel - activeFreehand.lastX, point.yPixel - activeFreehand.lastY) >= 2) {
      activeFreehand.drawing.points.push({ index: point.index, price: point.price });
      activeFreehand.lastX = point.xPixel;
      activeFreehand.lastY = point.yPixel;
      chart.update("none");
    }
    return;
  }
  if (!chartDrag || event.pointerId !== chartDrag.pointerId) return;
  const dx = event.clientX - chartDrag.x;
  const dy = event.clientY - chartDrag.y;
  chartDrag.x = event.clientX;
  chartDrag.y = event.clientY;
  panChartByPixels(dx, dy, false);
});
$("#chart").addEventListener("pointerup", event => {
  if (activeFreehand?.pointerId === event.pointerId) {
    const drawing = activeFreehand.drawing;
    activeFreehand = null;
    if (drawing.points.length < 2) chartDrawings = chartDrawings.filter(item => item !== drawing);
    else saveChartDrawings();
    chart.update("none");
    setDrawingTool(null);
    return;
  }
  if (!chartDrag || event.pointerId !== chartDrag.pointerId) return;
  chartDrag = null;
  saveChartViewport();
});
$("#chart").addEventListener("pointercancel", () => {
  chartDrag = null;
  if (activeFreehand) {
    activeFreehand = null;
    saveChartDrawings();
    if (chart) chart.update("none");
    setDrawingTool(null);
  }
});

function setDrawingTool(tool) {
  drawingTool = drawingTool === tool ? null : tool;
  document.querySelectorAll("[data-draw-tool]").forEach(button => {
    const active = button.dataset.drawTool === drawingTool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#chart").style.cursor = drawingTool ? "crosshair" : "default";
  $("#drawing-status").textContent = drawingTool === "freehand"
    ? "Drag across the chart to draw."
    : drawingTool === "text" ? "Click the chart to place your text."
      : drawingTool ? `Click the chart to place a ${drawingTool} line.`
        : "Choose a tool, then draw or click the chart.";
}

document.querySelector(".chart-drawing-tools").addEventListener("click", event => {
  const button = event.target.closest("[data-draw-tool]");
  if (button) { void requireActionSignIn().then(allowed => { if (allowed) setDrawingTool(button.dataset.drawTool); }); }
});
$("#btn-clear-drawings").addEventListener("click", async () => {
  if (!await requireActionSignIn()) return;
  chartDrawings = [];
  saveChartDrawings();
  if (chart) chart.update("none");
  updateHiddenDrawingButton();
  $("#drawing-status").textContent = "Chart lines cleared.";
});
$("#chart").addEventListener("click", event => {
  if (!drawingTool || !chart) return;
  if (!signedInUser) { void requireActionSignIn(); return; }
  if (drawingTool === "freehand") return;
  const point = drawingPointFromPointer(event);
  if (!point) return;
  if (drawingTool === "horizontal") chartDrawings.push({ type: "horizontal", price: point.price });
  else if (drawingTool === "vertical") chartDrawings.push({ type: "vertical", index: point.index });
  else if (drawingTool === "text") {
    const text = $("#drawing-text").value.trim();
    if (!text) { $("#drawing-status").textContent = "Type a short label before placing it."; return; }
    chartDrawings.push({ type: "text", index: point.index, price: point.price, text });
  }
  saveChartDrawings();
  chart.update("none");
  setDrawingTool(null);
});

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function findDrawingAt(clientX, clientY) {
  if (!chart?.chartArea) return -1;
  const rect = chart.canvas.getBoundingClientRect();
  const px = (clientX - rect.left) * (chart.width / rect.width);
  const py = (clientY - rect.top) * (chart.height / rect.height);
  const { x, y } = chart.scales;
  const tolerance = 9;
  for (let index = chartDrawings.length - 1; index >= 0; index--) {
    const drawing = chartDrawings[index];
    if (drawing.hidden) continue;
    let distance = Infinity;
    if (drawing.type === "horizontal") distance = Math.abs(py - y.getPixelForValue(drawing.price));
    else if (drawing.type === "vertical") distance = Math.abs(px - x.getPixelForValue(drawing.index));
    else if (drawing.type === "text") {
      const tx = x.getPixelForValue(drawing.index) + 5;
      const ty = y.getPixelForValue(drawing.price) + 5;
      const width = Math.min(220, Math.max(20, drawing.text.length * 7));
      if (px >= tx - tolerance && px <= tx + width + tolerance && py >= ty - tolerance && py <= ty + 24) distance = 0;
    } else if (drawing.type === "freehand" && drawing.points?.length > 1) {
      for (let point = 1; point < drawing.points.length; point++) {
        const a = drawing.points[point - 1], b = drawing.points[point];
        distance = Math.min(distance, pointSegmentDistance(px, py,
          x.getPixelForValue(a.index), y.getPixelForValue(a.price),
          x.getPixelForValue(b.index), y.getPixelForValue(b.price)));
      }
    }
    if (distance <= tolerance) return index;
  }
  return -1;
}

function closeDrawingMenu() {
  $("#drawing-context-menu").hidden = true;
  contextDrawingIndex = -1;
}

function updateHiddenDrawingButton() {
  const count = chartDrawings.filter(drawing => drawing.hidden).length;
  const button = $("#btn-show-hidden-drawings");
  button.hidden = count === 0;
  button.textContent = count ? `Show hidden (${count})` : "Show hidden";
}

$("#chart").addEventListener("contextmenu", event => {
  if (!signedInUser) { void requireActionSignIn(); return; }
  const index = findDrawingAt(event.clientX, event.clientY);
  if (index < 0) { closeDrawingMenu(); return; }
  event.preventDefault();
  contextDrawingIndex = index;
  const menu = $("#drawing-context-menu");
  menu.hidden = false;
  const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelector("button")?.focus();
});

$("#drawing-context-menu").addEventListener("click", async event => {
  if (!await requireActionSignIn()) return;
  const action = event.target.closest("[data-drawing-action]")?.dataset.drawingAction;
  const drawing = chartDrawings[contextDrawingIndex];
  if (!action || !drawing) { closeDrawingMenu(); return; }
  if (action === "delete") chartDrawings.splice(contextDrawingIndex, 1);
  if (action === "hide") drawing.hidden = true;
  if (action === "copy") {
    const copy = JSON.parse(JSON.stringify(drawing));
    delete copy.hidden;
    copy.label = `${drawingTitle(drawing, contextDrawingIndex)} copy`.slice(0, 48);
    const yRange = chart?.scales?.y ? chart.scales.y.max - chart.scales.y.min : 0;
    const priceNudge = Number.isFinite(yRange) ? yRange * 0.015 : 0;
    if (copy.type === "horizontal") copy.price += priceNudge;
    else if (copy.type === "vertical") copy.index += 1;
    else if (copy.type === "text") { copy.index += 1; copy.price += priceNudge; }
    else if (copy.type === "freehand") copy.points = copy.points.map(point => ({ index: point.index + 1, price: point.price + priceNudge }));
    chartDrawings.splice(contextDrawingIndex + 1, 0, copy);
  }
  saveChartDrawings();
  if (chart) chart.update("none");
  updateHiddenDrawingButton();
  closeDrawingMenu();
});

$("#btn-show-hidden-drawings").addEventListener("click", async () => {
  if (!await requireActionSignIn()) return;
  chartDrawings.forEach(drawing => { drawing.hidden = false; });
  saveChartDrawings();
  if (chart) chart.update("none");
  updateHiddenDrawingButton();
});

document.addEventListener("pointerdown", event => {
  if (!event.target.closest("#drawing-context-menu")) closeDrawingMenu();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeDrawingMenu(); });

async function renderPublicMarketChart(symbol) {
  if (!window.Chart) throw new Error("Chart library did not load. Reload the page to try again.");
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error("Invalid market symbol.");

  const dashboardIntervals = ["15m", "30m", "1h", "4h"];
  const intervals = [...new Set([...dashboardIntervals, chartInterval])];
  const fetched = await Promise.allSettled(intervals.map(interval => fetchBinanceCandles(symbol, interval, 168)));
  const candleData = Object.fromEntries(fetched.map((result, index) => [
    intervals[index], result.status === "fulfilled" ? result.value : null,
  ]));
  const candles = candleData[chartInterval];
  if (!candles?.length) throw new Error(`No ${chartInterval} candle data is available for ${symbol}.`);
  if (symbol !== selected) return;

  await refreshSupertrendDashboard(symbol, candleData);
  renderIndicatorReadouts(candles);
  const labels = candles.map(candle => new Date(candle.time).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: chartInterval.endsWith("m") ? "2-digit" : undefined,
  }));
  const closes = candles.map(candle => candle.close);
  const priceOverlays = buildPriceIndicatorOverlays(candles, closes);
  const latestPrice = closes[closes.length - 1];
  const previousPrice = closes[closes.length - 2];
  const changePct = previousPrice ? (latestPrice / previousPrice - 1) * 100 : 0;
  $("#sel-symbol").textContent = symbol;
  $("#sel-price").innerHTML = `${fmtMarketPrice(latestPrice)} <span class="${cls(changePct)}" style="font-size:14px">${fmtPct(changePct)} ${chartInterval}</span>`;
  $("#forecast-chips").innerHTML = `<span class="chip">Live Binance market data · ${chartInterval} candles</span>`;
  $("#forecast-grid").innerHTML = '<span class="muted small">Forecast unavailable until the app API is connected.</span>';

  const cfg = {
    type: "line",
    data: { labels, datasets: [
      { label: `${symbol} · ${chartInterval} close`, data: closes,
        borderColor: chartStyle === "candles" ? "transparent" : "#3b82f6", borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ...priceOverlays,
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: "#8b95a7", boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: { label: context => `${context.dataset.label}: ${fmtMarketPrice(context.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: "#8b95a7", maxTicksLimit: 10, font: { size: 10 } }, grid: { color: "#17202f" } },
        y: { ticks: { color: "#8b95a7", font: { size: 10 }, callback: value => fmtMarketPrice(value) }, grid: { color: "#17202f" } },
      },
    },
  };
  applySavedChartViewport(cfg.options, symbol);
  chartDrawings = loadChartDrawings(symbol);
  updateHiddenDrawingButton();
  if (chart) { chart.data = cfg.data; chart.options = cfg.options; }
  else chart = new Chart($("#chart"), cfg);
  chart.$publicCandles = candles;
  chart.$marketCandles = chartStyle === "candles" ? candles : null;
  chart.$indicatorCandles = candles;
  chart.$dashboardCandles = candleData;
  chart.$isPublicMarket = true;
  chart.$chartBounds = {
    xMin: 0, xMax: candles.length - 1,
    yMin: Math.min(...candles.map(candle => candle.low), ...priceOverlays.flatMap(dataset => dataset.data).filter(Number.isFinite)),
    yMax: Math.max(...candles.map(candle => candle.high), ...priceOverlays.flatMap(dataset => dataset.data).filter(Number.isFinite)),
  };
  chart.update("none");
  $("#market-updated").textContent = `Live price: every second · candles refresh each minute`;
  startMarketStream(symbol, chartInterval);
  setChartMessage("");
}

const BINANCE_INTERVAL_MS = { "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
function startMarketStream(symbol, interval) {
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !CHART_INTERVALS.includes(interval)) return;
  if (typeof WebSocket === "undefined") return;
  const symbols = [...new Set([symbol, ...priceAlerts.filter(alert => alert.active !== false).map(alert => alert.symbol)])]
    .filter(value => /^[A-Z0-9]{5,20}$/.test(value));
  const key = `${symbols.slice().sort().join(",")}:${interval}`;
  if (marketStreamKey === key && marketStream && marketStream.readyState <= WebSocket.OPEN) return;
  marketStreamKey = key;
  clearTimeout(marketStreamReconnect);
  if (marketStream) marketStream.close();
  try {
    const streams = symbols.flatMap(value => [`${value.toLowerCase()}@trade`, `${value.toLowerCase()}@kline_${interval}`]).join("/");
    marketStream = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    $("#market-updated").textContent = "Connecting to Binance live market stream…";
  } catch (error) {
    console.warn("market stream:", error.message);
    return;
  }
  marketStream.onopen = () => {
    if (marketStreamKey === key) $("#market-updated").textContent = "Binance live stream connected · updating each second";
  };
  marketStream.onmessage = message => {
    if (marketStreamKey !== key) return;
    try {
      const payload = JSON.parse(message.data);
      const data = payload.data || payload;
      if (data.e === "trade") {
        const updateSymbol = data.s;
        const price = Number(data.p);
        checkPriceAlerts(updateSymbol, price);
        if (updateSymbol === selected) pendingMarketKline = { symbol: updateSymbol, interval, time: Number(data.T), close: price, trade: true };
        return;
      }
      const raw = data.k;
      if (!raw) return;
      const updateSymbol = data.s || raw.s || symbol;
      const update = { symbol: updateSymbol, interval, time: Number(raw.t), open: Number(raw.o), high: Number(raw.h), low: Number(raw.l), close: Number(raw.c) };
      checkPriceAlerts(updateSymbol, update.close);
      if (updateSymbol === selected) pendingMarketKline = update;
    } catch { /* Ignore malformed stream updates and retain the last good candle. */ }
  };
  marketStream.onerror = () => marketStream?.close();
  marketStream.onclose = () => {
    if (marketStreamKey !== key) return;
    $("#market-updated").textContent = "Live stream disconnected · reconnecting…";
    marketStreamReconnect = setTimeout(() => {
      if (selected === symbol && chartInterval === interval) startMarketStream(symbol, interval);
    }, 3000);
  };
}

function applyLiveKline(update) {
  if (update.symbol !== selected || update.interval !== chartInterval) return;
  const { time, open, high, low, close } = update;
  const priceElement = $("#sel-price");
  const candles = chart?.$publicCandles;
  let previousClose = chart?.$historyPreviousClose;
  if (candles?.length) {
    const candleTime = update.trade ? Math.floor(time / (BINANCE_INTERVAL_MS[chartInterval] || 3600000)) * (BINANCE_INTERVAL_MS[chartInterval] || 3600000) : time;
    const last = candles.at(-1);
    if (last.time === candleTime && update.trade) {
      last.high = Math.max(last.high, close);
      last.low = Math.min(last.low, close);
      last.close = close;
    } else if (last.time === candleTime) Object.assign(last, { open, high, low, close });
    else if (candleTime > last.time) {
      previousClose = last.close;
      candles.push(update.trade ? { time: candleTime, open: close, high: close, low: close, close } : { time: candleTime, open, high, low, close });
      if (candles.length > 168) candles.shift();
    } else {
      const found = candles.find(candle => candle.time === candleTime);
      if (found && update.trade) {
        found.high = Math.max(found.high, close);
        found.low = Math.min(found.low, close);
        found.close = close;
      } else if (found) Object.assign(found, { open, high, low, close });
    }
    const labels = candles.map(candle => new Date(candle.time).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: chartInterval.endsWith("m") ? "2-digit" : undefined,
    }));
    const closes = candles.map(candle => candle.close);
    const overlays = buildPriceIndicatorOverlays(candles, closes);
    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = closes;
      chart.data.datasets[0].borderColor = chartStyle === "candles" ? "transparent" : "#3b82f6";
      chart.data.datasets.splice(1, chart.data.datasets.length - 1, ...overlays);
      chart.$marketCandles = chartStyle === "candles" ? candles : null;
      chart.$indicatorCandles = candles;
      chart.$chartBounds = { xMin: 0, xMax: candles.length - 1, yMin: Math.min(...candles.map(candle => candle.low)), yMax: Math.max(...candles.map(candle => candle.high)) };
      chart.update("none");
    }
    renderIndicatorReadouts(candles);
    if (activeIndicators.includes("supertrend") && chart?.$dashboardCandles) refreshSupertrendDashboard(update.symbol, chart.$dashboardCandles);
    previousClose = candles.length > 1 ? candles.at(-2).close : previousClose;
  } else if (chart && Number.isFinite(chart.$historyCandleIndex)) {
    const historyIndex = chart.$historyCandleIndex;
    if (Math.abs(time - chart.$historyCandleOpenTime) <= (BINANCE_INTERVAL_MS[chartInterval] || 3600000)) {
      chart.data.datasets[0].data[historyIndex] = close;
      if (chart.$indicatorCandles?.[historyIndex]) chart.$indicatorCandles[historyIndex].close = close;
      chart.update("none");
      renderIndicatorReadouts(chart.$indicatorCandles || []);
    }
  }
  const changePct = previousClose ? (close / previousClose - 1) * 100 : 0;
  if (priceElement) priceElement.innerHTML = `${fmtMarketPrice(close)} <span class="${cls(changePct)}" style="font-size:14px">${fmtPct(changePct)} ${chartInterval}</span>`;
  $("#market-updated").textContent = `Live price updated ${new Date().toLocaleTimeString()} · candle stream`;
}

setInterval(() => {
  if (!pendingMarketKline) return;
  const update = pendingMarketKline;
  pendingMarketKline = null;
  applyLiveKline(update);
}, 1000);

function setChartMessage(message) {
  const box = $("#chart-message");
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/* --------------------------------------------------------------------- news */
const PUBLIC_NEWS_FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "The Block", url: "https://www.theblock.co/rss.xml" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  // Asset-tag feeds keep major altcoin coverage visible alongside BTC headlines.
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss/tag/solana", coin: "SOLUSDT" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss/tag/ethereum", coin: "ETHUSDT" },
  // First-party Solana Foundation updates, alongside independent publisher coverage.
  { source: "Solana Foundation", url: "https://solana.com/news/rss.xml", coin: "SOLUSDT" },
];
let publicNewsCache = null;
let publicNewsFetchedAt = 0;

function cleanNewsText(value) {
  return new DOMParser().parseFromString(String(value || ""), "text/html")
    .body.textContent.replace(/\s+/g, " ").trim();
}

function newsAge(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const hours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
  return hours < 1 ? "just now" : hours < 24 ? `${Math.floor(hours)}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function safeNewsUrl(value) {
  try {
    const url = new URL(value);
    const trustedHosts = ["news.google.com", "coindesk.com", "theblock.co", "decrypt.co", "cointelegraph.com", "solana.com"];
    return url.protocol === "https:" && trustedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.href : "";
  } catch { return ""; }
}

async function fetchGoogleNewsFeed(query, limit = 10) {
  const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const localFeed = await fetch("/public-feed.json", { cache: "no-store" }).then(response => response.ok ? response.json() : null).catch(() => null);
  const localItems = query.includes("upcoming") ? localFeed?.events : localFeed?.news;
  if (Array.isArray(localItems) && localItems.length) return localItems.slice(0, limit).map(item => ({
    ...item,
    title: cleanNewsText(item.title || "Crypto headline"),
    summary: cleanNewsText(item.summary || ""),
    source: cleanNewsText(item.source || "Public crypto feed"),
  }));
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`,
    `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`,
  ];
  for (const proxyUrl of proxyUrls) {
    try {
      const response = await fetch(proxyUrl, { cache: "no-store" });
      if (!response.ok) continue;
      const body = await response.text();
      if (proxyUrl.includes("rss2json")) {
        const feed = JSON.parse(body);
        if (feed.status !== "ok") continue;
        return (feed.items || []).slice(0, limit).map(item => ({
          title: cleanNewsText(item.title || "Crypto event headline"),
          summary: cleanNewsText(item.description || item.content || ""),
          url: item.link || "https://news.google.com/",
          source: cleanNewsText(item.author || "Google News"),
          published: item.pubDate || "",
        }));
      }
      const xml = new DOMParser().parseFromString(body, "application/xml");
      if (xml.querySelector("parsererror")) continue;
      return [...xml.querySelectorAll("item")].slice(0, limit).map(item => ({
        title: cleanNewsText(item.querySelector("title")?.textContent || "Crypto event headline"),
        summary: cleanNewsText(item.querySelector("description")?.textContent || ""),
        url: item.querySelector("link")?.textContent || "https://news.google.com/",
        source: cleanNewsText(item.querySelector("source")?.textContent || "Google News"),
        published: item.querySelector("pubDate")?.textContent || "",
      }));
    } catch { /* Try the next provider or the next local deployment snapshot. */ }
  }
  throw new Error("Public news feed is temporarily unavailable.");
}

function newsCoins(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  const coins = [];
  if (/bitcoin|\bbtc\b/i.test(text)) coins.push("BTCUSDT");
  if (/ethereum|\beth\b|\bether\b/i.test(text)) coins.push("ETHUSDT");
  if (/solana|\bsol\b/i.test(text)) coins.push("SOLUSDT");
  return coins;
}

function headlineTone(items) {
  const text = items.map(item => `${item.title} ${item.summary || ""}`).join(" ").toLowerCase();
  const up = (text.match(/\b(rally|surge|surges|rise|rises|gain|gains|inflow|inflows|approval|approved|adoption|rebound|bullish)\b/g) || []).length;
  const down = (text.match(/\b(fall|falls|drop|drops|lower|plunge|plunges|crash|sell-off|outflow|outflows|liquidation|bearish|hot inflation)\b/g) || []).length;
  const score = Math.max(-1, Math.min(1, (up - down) / Math.max(3, up + down + 1)));
  return { score, label: score > 0.12 ? "Bullish" : score < -0.12 ? "Bearish" : "Neutral" };
}

async function fetchPublicNews(force = false) {
  if (!force && publicNewsCache && Date.now() - publicNewsFetchedAt < 10 * 60 * 1000) return publicNewsCache;
  const results = await Promise.allSettled(PUBLIC_NEWS_FEEDS.map(async ({ source, url: feedUrl, coin }) => {
    const endpoint = new URL("https://api.rss2json.com/v1/api.json");
    endpoint.searchParams.set("rss_url", feedUrl);
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    const feed = await response.json();
    if (feed.status !== "ok") throw new Error(`${source}: ${feed.message || "feed unavailable"}`);
    return (feed.items || []).map(item => ({
      title: cleanNewsText(item.title),
      summary: cleanNewsText(item.description || item.content).slice(0, 700),
      url: item.link,
      source,
      coin,
      published: item.pubDate,
    }));
  }));
  let items = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  if (!items.length) {
    items = await fetchGoogleNewsFeed("cryptocurrency market bitcoin ethereum", 30);
  }
  if (!items.length) throw new Error("Crypto news feeds are temporarily unavailable.");
  const seen = new Set();
  const recent = items.filter(item => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    const timestamp = Date.parse(item.published);
    return !Number.isFinite(timestamp) || Date.now() - timestamp < 7 * 24 * 3600000;
  }).map(item => ({
    ...item,
    coins: [...new Set([...newsCoins(item), ...(item.coin ? [item.coin] : [])])],
    age: newsAge(item.published),
  })).sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
  const market = headlineTone(recent);
  publicNewsCache = { market, items: recent, fear_greed: null, ai: null, source: "publisher RSS" };
  publicNewsFetchedAt = Date.now();
  return publicNewsCache;
}

async function refreshCryptoEvents() {
  const box = $("#crypto-events-list");
  if (!box) return;
  try {
      const events = await fetchGoogleNewsFeed("crypto upcoming event token unlock mainnet listing conference", 5);
    box.innerHTML = events.length ? events.map(event => {
      const url = safeNewsUrl(event.url) || "https://news.google.com/";
      return `<article class="crypto-event-item"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(event.title)}</a><small>${esc(event.source)} · ${esc(newsAge(event.published) || "recent")}</small></article>`;
    }).join("") : '<div class="muted small">No event headlines are available right now.</div>';
  } catch (error) {
    console.warn("crypto events:", error.message);
    box.innerHTML = '<div class="muted small">No verified event headlines are available right now. The panel will refresh automatically.</div>';
  }
}

async function refreshNews(force = false) {
  let d;
  try {
    d = await api("/api/news?symbols=BTCUSDT,SOLUSDT,ETHUSDT");
  } catch (e) {
    console.warn("app news API unavailable; using publisher RSS feeds:", e.message);
    try {
      d = await fetchPublicNews(force);
    } catch (feedError) {
      console.warn("publisher news feeds:", feedError.message);
      $("#asset-news").innerHTML = `<div class="muted small">${esc(feedError.message)} <a href="https://www.coindesk.com/" target="_blank" rel="noopener">Open CoinDesk</a></div>`;
      $("#news-list").innerHTML = '<div class="news-empty-state">News is unavailable right now. Try refreshing in a little while.</div>';
      return;
    }
  }

  try {
    const fg = d.fear_greed;
    $("#fear-greed").textContent = fg ? `Fear & Greed index: ${fg.value} (${fg.classification})` : "";
    const score = d.market?.score ?? 0;
    const posPct = ((score + 1) / 2 * 100).toFixed(0);
    
    // Get whale data for selected symbol + market-wide
    let whaleInfo = "";
    let marketWhaleInfo = "";
    
    // Market-wide whale sentiment
    if (d.market_whale_sentiment) {
      const market = d.market_whale_sentiment;
      const impactColors = {
        'none': '#666',
        'low': '#888', 
        'medium': '#f59e0b',
        'high': '#ef4444',
        'extreme': '#dc2626'
      };
      marketWhaleInfo = `
        <div class="market-whale-info" style="margin-top:8px;padding:6px;background:rgba(168,85,247,0.1);border-radius:4px;font-size:11px">
          <div style="display:flex;justify-content:space-between">
            <span>🌊 Market Whale Impact</span>
            <span style="color:${impactColors[market.impact_level] || '#666'}">${market.impact_level.toUpperCase()}</span>
          </div>
          <div class="muted">Market Score: ${market.market_score >= 0 ? '+' : ''}${market.market_score.toFixed(2)} (${market.market_label}) | Total Vol: $${(market.total_volume || 0).toLocaleString()}</div>
        </div>`;
    }
    
    // Coin-specific whale data
    if (selected && d.whale_data?.[selected]) {
      const whale = d.whale_data[selected];
      whaleInfo = `
        <div class="whale-info" style="margin-top:8px;padding:8px;background:rgba(59,130,246,0.1);border-radius:4px;font-size:12px">
          <div style="display:flex;justify-content:space-between">
            <span>🐋 ${selected} Whale Activity</span>
            <span class="${whale.score > 0 ? 'up' : whale.score < 0 ? 'down' : ''}">${whale.label}</span>
          </div>
          <div class="muted">Score: ${whale.score >= 0 ? '+' : ''}${whale.score.toFixed(2)} | Vol: $${(whale.total_volume_usdt || 0).toLocaleString()}</div>
          ${whale.count > 0 ? `<div class="muted">${whale.count} recent txs | Buy: $${(whale.buy_volume || 0).toLocaleString()} | Sell: $${(whale.sell_volume || 0).toLocaleString()}</div>` : '<div class="muted">No recent whale activity</div>'}
          ${whale.combined_score !== undefined ? `<div class="muted">Combined Score (with market): ${whale.combined_score >= 0 ? '+' : ''}${whale.combined_score.toFixed(2)}</div>` : ''}
        </div>`;
    }
    
    $("#sentiment-box").innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:13px">
        <b>${d.market?.label ?? "Unknown"}</b><span class="muted">score ${score >= 0 ? "+" : ""}${score.toFixed(2)}</span>
      </div>
      <div class="sentiment-bar"><div class="sentiment-marker" style="left:${posPct}%"></div></div>
      <div class="sentiment-line muted"><span>Bearish</span><span>Bullish</span></div>
      ${d.source === "publisher RSS" ? '<div class="muted small">Estimated tone from recent publisher headlines</div>' : ""}
      ${d.ai?.summary ? `<div class="ai-summary">🤖 <b>AI:</b> ${esc(d.ai.summary)}${d.ai.key_events?.length ? "<br><span class='muted'>Key: " + d.ai.key_events.map(esc).join(" · ") + "</span>" : ""}</div>` : ""}`
      + marketWhaleInfo + whaleInfo;
    const focus = [["BTCUSDT", "BTC"], ["SOLUSDT", "SOL"], ["ETHUSDT", "ETH"]];
    $("#asset-news").innerHTML = focus.map(([symbol, coin]) => {
      const item = (d.items || []).find(article => article.coins?.some(value => value === symbol || value === coin));
      if (!item) return `<div class="asset-news-card"><div class="asset-news-head"><span class="asset-news-coin">${coin}</span><span class="asset-news-source">No recent source headline specifically names ${coin}</span></div></div>`;
      const rawSummary = cleanNewsText(item.summary || item.description || "");
      const summary = rawSummary ? `${rawSummary.slice(0, 320)}${rawSummary.length > 320 ? "…" : ""}` : "The publisher has not included a summary in its feed. Open the report for the full explanation.";
      const url = safeNewsUrl(item.url);
      return `<article class="asset-news-card">
        <div class="asset-news-head"><span class="asset-news-coin">${coin}</span><span class="asset-news-source">${esc(item.source || "News source")}${item.age ? ` · ${esc(item.age)}` : ""}</span></div>
        <div class="asset-news-title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title)}</div>
        <p class="asset-news-summary"><b>Reported context:</b> ${esc(summary)}</p>
      </article>`;
    }).join("");
    $("#news-list").innerHTML = (d.items || []).slice(0, 14).map(it => `
      <div class="news-item">
        <div class="news-title">${safeNewsUrl(it.url) ? `<a href="${esc(safeNewsUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</div>
        ${it.summary || it.description ? `<p class="asset-news-summary">${esc(cleanNewsText(it.summary || it.description).slice(0, 320))}</p>` : ""}
        <div class="news-meta">
          ${sentTag(it.score)}<span>${esc(it.source)}</span>${it.age ? `<span>${esc(it.age)}</span>` : ""}
          ${it.coins?.length ? `<span>${it.coins.map(c => c.replace("USDT", "")).join(", ")}</span>` : ""}
        </div>
      </div>`).join("") || '<div class="news-empty-state">No upcoming crypto news right now.</div>';
  } catch (e) { console.warn("news render:", e.message); }
}
$("#btn-news-refresh").addEventListener("click", () => refreshNews(true));

/* ------------------------------------------------------- pending & trades */
async function refreshPending() {
  try {
    const list = await api("/api/pending");
    const open = list.filter(p => ["pending", "executing"].includes(p.status));
    const done = list.filter(p => !["pending", "executing"].includes(p.status)).slice(0, 4);
    const render = (p) => `
      <div class="pending-card">
        <div class="head"><b class="side-${p.side.toLowerCase()}">${p.side}</b><b>${p.symbol}</b>
          <span class="muted small">🕐 ${esc(String(p.created_at || "").slice(5, 16).replace("T", " "))} · ${p.status === "pending" ? "expires " + p.expires_at.slice(11, 16) : p.status}</span></div>
        <div class="meta">
          signal ${fmtUSD(p.signal_price)} · trigger ${fmtUSD(p.target_price)}<br>
          🤖 AI ${p.ai?.decision?.toUpperCase() || "—"}: ${esc(p.ai?.reason || "")}
          ${p.ai?.advisor ? `<br>🧠 advisor: <b>${esc(p.ai.advisor.action)}</b> (${Math.round((p.ai.advisor.confidence || 0) * 100)}%)` : ""}
          ${p.note ? `<br>note: ${esc(p.note)}` : ""}
        </div>
        ${p.status === "pending" ? `<div class="btns">
          <button class="btn success tiny" data-pid="${p.id}" data-act="confirm">✅ Confirm</button>
          <button class="btn danger tiny" data-pid="${p.id}" data-act="cancel">❌ Cancel</button>
        </div>` : ""}
      </div>`;
    $("#pending-list").innerHTML = [...open, ...done].map(render).join("") || '<div class="muted small">None.</div>';
  } catch (e) { console.warn(e); }
}
$("#pending-list").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  try {
    await api(`/api/pending/${b.dataset.pid}/${b.dataset.act}`, { method: "POST" });
    toast(`Order ${b.dataset.act}led`);
    refreshPending(); refreshCoins(); refreshTrades();
  } catch (e) { toast(e.message, true); }
});

$("#btn-clear-pending").addEventListener("click", async () => {
  if (!confirm("Clear all pending confirmations? This cannot be undone.")) return;
  try {
    await api("/api/pending", { method: "DELETE" });
    toast("All pending confirmations cleared");
    refreshPending();
  } catch (e) { toast(e.message, true); }
});

async function refreshTrades() {
  try {
    const list = await api("/api/trades");
    $("#trades-table tbody").innerHTML = list.map(t => {
      const basis = t.decision_basis || "unknown";
      const basisColors = {
        "ai_supported": "🟢",
        "ai_overridden": "🟡", 
        "manual": "🔵",
        "user_confirmed": "🟢",
        "ai_neutral": "⚪",
        "unknown": "⚫"
      };
      const basisLabel = {
        "ai_supported": "AI Supported",
        "ai_overridden": "AI Overridden",
        "manual": "Manual",
        "user_confirmed": "User Confirmed", 
        "ai_neutral": "AI Neutral",
        "unknown": "Unknown"
      };
      
      return `
      <tr>
        <td>${esc(String(t.time).replace("T", " ").slice(0, 16))}</td>
        <td class="side-${t.side.toLowerCase()}">${t.side}</td>
        <td>${t.symbol}</td>
        <td>${Number(t.qty).toFixed(6)}</td>
        <td>${fmtUSD(t.price)}</td>
        <td>${fmtUSD(t.quote)}</td>
        <td class="${cls(t.pnl ?? 0)}">${t.pnl != null ? `${fmtUSD(t.pnl)} (${fmtPct(t.pnl_pct)})` : "—"}</td>
        <td>${t.mode}</td>
        <td class="muted small">${basisColors[basis] || "⚫"} ${basisLabel[basis] || basis}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="9" class="muted">No trades yet.</td></tr>';
  } catch (e) { console.warn(e); }
}

/* ------------------------------------------------------------- bot & balance */
$("#btn-bot").addEventListener("click", async () => {
  try {
    const st = await api("/api/status");
    await api(st.running ? "/api/bot/stop" : "/api/bot/start", { method: "POST" });
    toast(st.running ? "Bot paused" : "Bot started");
    refreshStatus();
  } catch (e) { toast(e.message, true); }
});

$("#btn-balances").addEventListener("click", async () => {
  try {
    const b = await api("/api/balances");
    const lines = b.filter(x => x.asset === "USDT" || x.asset === "BUSD" || x.free > 0.0001)
      .slice(0, 12).map(x => `${x.asset}: ${x.free}`.replace(/\.\d+/, m => m.slice(0, 8)));
    toast("💰 " + (lines.join(" · ") || "no balances"), false);
  } catch (e) { toast(e.message, true); }
});

$("#btn-report").addEventListener("click", async () => {
  try {
    const report = await api("/api/report");
    const summary = report.summary;
    
    let reportText = `📊 AI Trading Report\n\n`;
    reportText += `Total Trades: ${summary.total_trades}\n`;
    reportText += `Decision Breakdown:\n`;
    
    const basisLabels = {
      "ai_supported": "🟢 AI Supported",
      "ai_overridden": "🟡 AI Overridden", 
      "manual": "🔵 Manual",
      "user_confirmed": "🟢 User Confirmed",
      "ai_neutral": "⚪ AI Neutral",
      "unknown": "⚫ Unknown"
    };
    
    for (const [basis, count] of Object.entries(summary.decision_basis_breakdown)) {
      if (count > 0) {
        reportText += `  ${basisLabels[basis] || basis}: ${count}\n`;
      }
    }
    
    reportText += `\nPerformance by Decision:\n`;
    for (const [basis, perf] of Object.entries(summary.performance_by_basis)) {
      if (perf.total_trades > 0) {
        reportText += `  ${basisLabels[basis] || basis}: ${perf.total_trades} trades, PnL: $${perf.total_pnl}, Win Rate: ${perf.win_rate}%\n`;
      }
    }
    
    alert(reportText);
  } catch (e) { toast(e.message, true); }
});


$("#btn-ai-status").addEventListener("click", () => {
  refreshAIStatus();
});

/* --------------------------------------------------------------------- boot */
async function refreshMarket(force = false) {
  if (marketRefreshInFlight) return;
  marketRefreshInFlight = true;
  const button = $("#btn-market-refresh");
  if (button) { button.disabled = true; button.textContent = "↻ Refreshing…"; }
  try {
    await Promise.allSettled([refreshCoins(force), selected ? refreshForecast(false) : Promise.resolve()]);
    if (!chart) $("#market-updated").textContent = "Connecting to the live market stream…";
  } finally {
    marketRefreshInFlight = false;
    if (button) { button.disabled = false; button.textContent = "↻ Refresh market"; }
  }
}

$("#chart-style").value = chartStyle;
$("#chart-interval").value = chartInterval;
renderIndicatorControls();
$("#indicator-select").addEventListener("change", renderIndicatorControls);
$("#btn-add-indicator").addEventListener("click", async () => {
  if (!await requireActionSignIn()) return;
  const name = $("#indicator-select").value;
  if (!INDICATOR_OPTIONS[name] || activeIndicators.includes(name) || activeIndicators.length >= 3) return;
  activeIndicators.push(name);
  localStorage.setItem(INDICATORS_KEY, JSON.stringify(activeIndicators));
  renderIndicatorControls();
  renderIndicatorReadouts(chart?.$indicatorCandles || []);
  refreshMarket(true);
});
$("#active-indicators").addEventListener("click", async event => {
  const button = event.target.closest("[data-remove-indicator]");
  if (!button) return;
  if (!await requireActionSignIn()) return;
  activeIndicators = activeIndicators.filter(name => name !== button.dataset.removeIndicator);
  localStorage.setItem(INDICATORS_KEY, JSON.stringify(activeIndicators));
  renderIndicatorControls();
  renderIndicatorReadouts(chart?.$indicatorCandles || []);
  refreshMarket(true);
});
$("#chart-style").addEventListener("change", async (event) => {
  if (!await requireActionSignIn()) { event.target.value = chartStyle; return; }
  chartStyle = event.target.value === "candles" ? "candles" : "line";
  localStorage.setItem("market-chart-style", chartStyle);
  refreshMarket(true);
});
$("#chart-interval").addEventListener("change", async (event) => {
  if (!await requireActionSignIn()) { event.target.value = chartInterval; return; }
  chartInterval = CHART_INTERVALS.includes(event.target.value) ? event.target.value : "1h";
  localStorage.setItem("market-chart-interval", chartInterval);
  refreshMarket(true);
});
$("#btn-market-refresh").addEventListener("click", () => refreshMarket(true));

refreshStatus(); refreshMarket(); refreshNews(); refreshCryptoEvents(); refreshPending(); refreshTrades(); refreshWallet();
setInterval(refreshStatus, 10000);
setInterval(() => refreshMarket(), 60 * 1000);
setInterval(refreshNews, 10 * 60 * 1000);
setInterval(refreshCryptoEvents, 10 * 60 * 1000);
setInterval(refreshPending, 8000);
setInterval(refreshTrades, 10000);
setInterval(refreshWallet, 10000);

/* --------------------------------------------------------------------- chat */
const chatWidget = document.getElementById('chat-widget');
const chatHeader = document.getElementById('chat-header');
const chatToggle = document.getElementById('chat-toggle');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input-field');
const chatSend = document.getElementById('chat-send');
const chatHistory = [];const chatPositionKey = 'ai-trader-chat-position';
let chatDragState = null;
let chatDragMoved = false;

function clampChatPosition(left, top) {
  const maxLeft = Math.max(8, window.innerWidth - chatWidget.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - chatWidget.offsetHeight - 8);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top: Math.min(Math.max(8, top), maxTop)
  };
}

function setChatPosition(left, top) {
  const position = clampChatPosition(left, top);
  chatWidget.style.left = `${position.left}px`;
  chatWidget.style.top = `${position.top}px`;
  chatWidget.style.right = 'auto';
  chatWidget.style.bottom = 'auto';
}

function initializeChatPosition() {
  const saved = localStorage.getItem(chatPositionKey);
  if (saved) {
    try {
      const position = JSON.parse(saved);
      setChatPosition(Number(position.left), Number(position.top));
      return;
    } catch {
      localStorage.removeItem(chatPositionKey);
    }
  }

  const rect = chatWidget.getBoundingClientRect();
  setChatPosition(rect.left, rect.top);
}

function saveChatPosition() {
  localStorage.setItem(chatPositionKey, JSON.stringify({
    left: parseFloat(chatWidget.style.left),
    top: parseFloat(chatWidget.style.top)
  }));
}

function startChatIntro() {
  const rect = chatWidget.getBoundingClientRect();
  chatWidget.style.setProperty('--chat-start-x', `${rect.left}px`);
  chatWidget.style.setProperty('--chat-start-y', `${rect.top}px`);
  chatWidget.classList.add('chat-intro');
  chatWidget.addEventListener('animationend', () => {
    chatWidget.classList.remove('chat-intro');
  }, { once: true });
}

initializeChatPosition();
window.requestAnimationFrame(startChatIntro);

chatWidget.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('input, button')) return;
  if (chatWidget.classList.contains('expanded') && !event.target.closest('.chat-header')) return;
  const rect = chatWidget.getBoundingClientRect();
  chatDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    startLeft: rect.left,
    startTop: rect.top
  };
  chatDragMoved = false;
  event.preventDefault();
});

document.addEventListener('pointermove', (event) => {
  if (!chatDragState || event.pointerId !== chatDragState.pointerId) return;
  const left = event.clientX - chatDragState.offsetX;
  const top = event.clientY - chatDragState.offsetY;
  if (Math.abs(left - chatDragState.startLeft) > 3 || Math.abs(top - chatDragState.startTop) > 3) {
    chatDragMoved = true;
    chatWidget.classList.add('dragging');
    setChatPosition(left, top);
    event.preventDefault();
  }
});

document.addEventListener('pointerup', (event) => {
  if (!chatDragState || event.pointerId !== chatDragState.pointerId) return;
  chatWidget.classList.remove('dragging');
  if (chatDragMoved) {
    saveChatPosition();
    setTimeout(() => { chatDragMoved = false; }, 0);
  }
  chatDragState = null;
});

document.addEventListener('pointercancel', () => {
  chatDragState = null;
  chatWidget.classList.remove('dragging');
});
window.addEventListener('resize', () => {
  if (!chatWidget.style.left) return;
  setChatPosition(parseFloat(chatWidget.style.left), parseFloat(chatWidget.style.top));
  if (!chatWidget.classList.contains('minimized')) saveChatPosition();
});

function restoreChatHome() {
  localStorage.removeItem(chatPositionKey);
  chatWidget.style.removeProperty('left');
  chatWidget.style.removeProperty('top');
  chatWidget.style.removeProperty('right');
  chatWidget.style.removeProperty('bottom');
}

// Toggle chat widget (click on header/icon to expand)
chatHeader.addEventListener('click', (event) => {
  if (chatDragMoved) return;
  chatWidget.classList.toggle('expanded');
  chatWidget.classList.toggle('minimized');
  if (chatWidget.classList.contains("minimized")) restoreChatHome();
  chatToggle.textContent = chatWidget.classList.contains('minimized') ? '+' : '−';
  
  // Add welcome message when first expanded
  if (!chatWidget.classList.contains('minimized') && chatMessages.children.length === 0) {
    addChatMessage('Hi! I\'m your AI trading assistant with live market data. Ask about current conditions, reports, or give trading commands like "buy SOL" or "sell half".', 'assistant');
  }
});

// Send message on Enter key
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendChatMessage();
  }
});

// Send message on button click
chatSend.addEventListener('click', sendChatMessage);

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  // Add user message to chat
  addChatMessage(message, 'user');
  const previousHistory = chatHistory.slice(-12);
  chatHistory.push({ role: 'user', content: message });
  chatInput.value = '';

  // Show typing indicator
  addChatMessage('🤖 Thinking...', 'system');

  // Send to backend
  try {
    const response = await api('/api/chat', {
      method: 'POST',
      authRequired: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: previousHistory })
    });

    // Remove typing indicator
    const typingMessage = chatMessages.lastElementChild;
    if (typingMessage && typingMessage.textContent === '🤖 Thinking...') {
      typingMessage.remove();
    }

    // Add assistant response to chat
    addChatMessage(response.response, 'assistant');
    chatHistory.push({ role: 'assistant', content: response.response });
  } catch (error) {
    // Remove typing indicator
    const typingMessage = chatMessages.lastElementChild;
    if (typingMessage && typingMessage.textContent === '🤖 Thinking...') {
      typingMessage.remove();
    }
    addChatMessage('Sorry, I encountered an error. Please try again.', 'system');
  }
}

function addChatMessage(text, type) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${type}`;
  messageDiv.textContent = text;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Initial welcome message (only when expanded)
// addChatMessage('Hi! I\'m your AI trading assistant powered by Groq. Ask me about reports, market conditions, or give trading commands like "buy SOL" or "sell half".', 'assistant');
