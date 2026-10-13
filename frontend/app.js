/* AI Crypto Trader — dashboard logic */
const $ = (s) => document.querySelector(s);
let TOKEN = localStorage.getItem("app_token") || "";
let chart = null;
let selected = localStorage.getItem("selected_symbol") || "BTCUSDT";

// Function to clear cached token
function clearToken() {
  localStorage.removeItem("app_token");
  TOKEN = "";
  toast("Token cleared - please refresh and enter new token");
  setTimeout(() => location.reload(), 1500);
}
let coinsCache = {};
let forecastCache = null;
const API_BASE_URL = (window.API_BASE_URL || "").replace(/\/+$/, "");

const QUICK = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "LINK"];

/* ------------------------------------------------------------------ helpers */
async function api(path, opts = {}) {
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (TOKEN) opts.headers["X-App-Token"] = TOKEN;
  const res = await fetch(`${API_BASE_URL}${path}`, opts);
  if (res.status === 401) {
    // Clear the cached token since it's not working
    localStorage.removeItem("app_token");
    TOKEN = "";
    
    const t = prompt("This server requires an access token (APP_TOKEN from .env):");
    if (t) { TOKEN = t; localStorage.setItem("app_token", t); return api(path, opts); }
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
    $("#bot-state").textContent = st.running ? "bot running" : "bot paused";
    $("#bot-state").className = "badge " + (st.running ? "on" : "off");
    $("#btn-bot").textContent = st.running ? "⏸ Pause bot" : "▶ Start bot";
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
async function refreshCoins() {
  let list;
  try { list = await api("/api/coins"); } catch (e) { return; }
  coinsCache = {};
  for (const c of list) coinsCache[c.symbol] = c;

  const prevSelected = selected;
  if (!selected || !coinsCache[selected]) {
    selected = list[0]?.symbol || "";
    localStorage.setItem("selected_symbol", selected);
  }
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
    if (selected !== sym) { selected = sym; localStorage.setItem("selected_symbol", sym); refreshCoins(); refreshForecast(); }
    else card.classList.toggle("open");
    return;
  }
  try {
    if (act === "save") {
      const fields = {};
      card.querySelectorAll("input[data-f]").forEach(i => fields[i.dataset.f] = parseFloat(i.value));
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify(fields) });
      toast(`${sym} settings saved`);
    } else if (act === "manual-buy" || act === "manual-sell") {
      await api("/api/manual-trade", { method: "POST", body: JSON.stringify({ symbol: sym, side: act === "manual-buy" ? "BUY" : "SELL" }) });
      toast(`${act === "manual-buy" ? "Buy" : "Sell"} signal created for ${sym} — check pending/Telegram`);
    } else if (act === "re-anchor") {
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify({ reset_anchor: true }) });
      toast(`${sym} will re-anchor to current price on next check`);
    } else if (act === "toggle") {
      const en = coinsCache[sym]?.enabled;
      await api(`/api/coins/${sym}`, { method: "PATCH", body: JSON.stringify({ enabled: !en }) });
    } else if (act === "remove") {
      if (!confirm(`Remove ${sym}? (positions info is removed too, funds stay on Binance)`)) return;
      await api(`/api/coins/${sym}`, { method: "DELETE" });
      toast(`${sym} removed`);
    }
    await refreshCoins();
  } catch (e) { toast(e.message, true); }
});

async function addCoin(sym) {
  const symbol = sym.toUpperCase().endsWith("USDT") ? sym.toUpperCase() : `${sym.toUpperCase()}USDT`;
  try {
    const r = await api("/api/coins", { method: "POST", body: JSON.stringify({ symbol }) });
    toast(`${r.symbol} added — anchored at ${fmtUSD(r.anchor_price)}`);
    $("#new-symbol").value = "";
    await refreshCoins();
  } catch (e) {
    if (e.message.startsWith("HTTP 404")) {
      selected = symbol;
      localStorage.setItem("selected_symbol", selected);
      await refreshForecast();
      toast(`${symbol} selected for the live chart`);
      return;
    }
    toast(e.message, true);
  }
}
$("#btn-add").addEventListener("click", () => { const v = $("#new-symbol").value.trim(); if (v) addCoin(v); });
$("#new-symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add").click(); });
$("#quick-add").innerHTML = QUICK.map(s => `<button data-s="${s}">${s}</button>`).join("");
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
async function refreshForecast() {
  if (!selected) {
    setChartMessage("Add a coin to load its live market chart.");
    return;
  }
  const symbol = selected;
  setChartMessage("Loading live market chart…");
  try {
    const f = await api(`/api/forecast/${symbol}`);
    if (symbol !== selected) return;
    forecastCache = f;
    renderForecast(f);
    renderChart(f);
  } catch (e) {
    console.warn("forecast:", e.message);
    if (symbol === selected) {
      try {
        await renderPublicMarketChart(symbol);
      } catch (marketError) {
        setChartMessage(`Chart unavailable: ${marketError.message}`);
      }
    }
  }
  refreshAdvice();
  refreshAIStatus();
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
  if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update(); }
  else chart = new Chart($("#chart"), cfg);
  setChartMessage("");
}

async function renderPublicMarketChart(symbol) {
  if (!window.Chart) throw new Error("Chart library did not load. Reload the page to try again.");
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error("Invalid market symbol.");

  const endpoint = new URL("https://api.binance.com/api/v3/klines");
  endpoint.search = new URLSearchParams({ symbol, interval: "1h", limit: "168" });
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
  const candles = await response.json();
  if (!Array.isArray(candles) || candles.length < 2) throw new Error(`No candle data is available for ${symbol}.`);
  if (symbol !== selected) return;

  const labels = candles.map(candle => new Date(candle[0]).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit"
  }));
  const closes = candles.map(candle => Number(candle[4]));
  const latestPrice = closes[closes.length - 1];
  const previousPrice = closes[closes.length - 2];
  const changePct = previousPrice ? (latestPrice / previousPrice - 1) * 100 : 0;
  $("#sel-symbol").textContent = symbol;
  $("#sel-price").innerHTML = `${fmtUSD(latestPrice, 2)} <span class="${cls(changePct)}" style="font-size:14px">${fmtPct(changePct)} 1h</span>`;
  $("#forecast-chips").innerHTML = '<span class="chip">Live Binance market data</span>';
  $("#forecast-grid").innerHTML = '<span class="muted small">Forecast unavailable until the app API is connected.</span>';

  const cfg = {
    type: "line",
    data: { labels, datasets: [{
      label: `${symbol} · hourly close`, data: closes,
      borderColor: "#3b82f6", borderWidth: 2, pointRadius: 0, tension: 0.2,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: "#8b95a7", boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: { label: context => `${context.dataset.label}: ${fmtUSD(context.parsed.y, 2)}` } },
      },
      scales: {
        x: { ticks: { color: "#8b95a7", maxTicksLimit: 10, font: { size: 10 } }, grid: { color: "#17202f" } },
        y: { ticks: { color: "#8b95a7", font: { size: 10 }, callback: value => "$" + Number(value).toLocaleString() }, grid: { color: "#17202f" } },
      },
    },
  };
  if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update(); }
  else chart = new Chart($("#chart"), cfg);
  setChartMessage("");
}

function setChartMessage(message) {
  const box = $("#chart-message");
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/* --------------------------------------------------------------------- news */
async function refreshNews() {
  try {
    const d = await api("/api/news");
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
      ${d.ai?.summary ? `<div class="ai-summary">🤖 <b>AI:</b> ${esc(d.ai.summary)}${d.ai.key_events?.length ? "<br><span class='muted'>Key: " + d.ai.key_events.map(esc).join(" · ") + "</span>" : ""}</div>` : ""}`
      + marketWhaleInfo + whaleInfo;
    $("#news-list").innerHTML = (d.items || []).slice(0, 14).map(it => `
      <div class="news-item">
        <div class="news-title"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></div>
        <div class="news-meta">
          ${sentTag(it.score)}<span>${esc(it.source)}</span>${it.age ? `<span>${esc(it.age)}</span>` : ""}
          ${it.coins?.length ? `<span>${it.coins.map(c => c.replace("USDT", "")).join(", ")}</span>` : ""}
        </div>
      </div>`).join("") || '<div class="muted small">No news loaded.</div>';
  } catch (e) { console.warn("news:", e.message); }
}
$("#btn-news-refresh").addEventListener("click", refreshNews);

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

$("#btn-clear-token").addEventListener("click", () => {
  clearToken();
});

$("#btn-ai-status").addEventListener("click", () => {
  refreshAIStatus();
});

/* --------------------------------------------------------------------- boot */
refreshStatus(); refreshCoins(); refreshForecast(); refreshNews(); refreshPending(); refreshTrades(); refreshWallet();
setInterval(refreshStatus, 10000);
setInterval(refreshCoins, 10000);
setInterval(refreshForecast, 90000);
setInterval(refreshNews, 120000);
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
