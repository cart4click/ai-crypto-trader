(() => {
  const marketBox = document.querySelector("#live-market-list");
  const newsBox = document.querySelector("#live-news-list");
  if (!marketBox || !newsBox) return;

  const symbols = [
    ["BTCUSDT", "BTC"],
    ["ETHUSDT", "ETH"],
    ["BNBUSDT", "BNB"],
    ["SOLUSDT", "SOL"],
    ["XRPUSDT", "XRP"],
  ];
  const newsFeeds = [
    ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
    ["Decrypt", "https://decrypt.co/feed"],
    ["Cointelegraph", "https://cointelegraph.com/rss"],
  ];

  const escapeText = value => String(value || "").replace(/[&<>\"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function formatPrice(value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return "—";
    return price >= 1000 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `$${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  }

  function sparkline(values, direction) {
    const clean = values.map(Number).filter(Number.isFinite);
    if (clean.length < 2) return "";
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const span = max - min || 1;
    const points = clean.map((value, index) => {
      const x = (index / (clean.length - 1)) * 100;
      const y = 25 - ((value - min) / span) * 20;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg class="live-sparkline" viewBox="0 0 100 28" role="img" aria-label="${direction === "up" ? "Upward" : "Downward"} recent price movement"><polyline class="${direction}" points="${points}"></polyline></svg>`;
  }

  async function loadMarkets() {
    try {
      const requested = encodeURIComponent(JSON.stringify(symbols.map(([symbol]) => symbol)));
      const tickers = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbols=${requested}`);
      const rows = await Promise.all(symbols.map(async ([symbol, name]) => {
        const ticker = tickers.find(item => item.symbol === symbol);
        if (!ticker) return null;
        let closes = [];
        try {
          const candles = await getJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=18`);
          closes = candles.map(candle => candle[4]);
        } catch { /* The quote remains useful if the sparkline provider is unavailable. */ }
        const change = Number(ticker.priceChangePercent);
        const direction = change >= 0 ? "up" : "down";
        return `<article class="live-market"><div class="live-market-main"><div class="live-market-name"><span>${name}</span><span class="live-market-change ${direction}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span></div><div class="live-market-price">${formatPrice(ticker.lastPrice)}</div></div>${sparkline(closes, direction)}</article>`;
      }));
      marketBox.innerHTML = rows.filter(Boolean).join("") || '<div class="live-empty">Market data is temporarily unavailable.</div>';
    } catch (error) {
      console.warn("Landing market preview unavailable:", error.message);
      marketBox.innerHTML = '<div class="live-empty">Market data is temporarily unavailable. The dashboard remains available after sign-in.</div>';
    }
  }

  function feedItem(source, item) {
    const url = String(item.link || "");
    const trusted = /^https:\/\/(www\.)?(coindesk\.com|decrypt\.co|cointelegraph\.com)\//i.test(url);
    const title = escapeText(item.title || "Untitled headline");
    const age = item.pubDate ? new Date(item.pubDate) : null;
    const ageText = age && Number.isFinite(age.getTime()) ? `${Math.max(0, Math.floor((Date.now() - age.getTime()) / 3600000))}h ago` : "recent";
    return `<article class="live-news-item"><a href="${trusted ? escapeText(url) : "https://www.coindesk.com/"}" target="_blank" rel="noopener">${title}</a><div class="live-news-meta">${escapeText(source)} · ${ageText}</div></article>`;
  }

  async function loadNews() {
    try {
      const results = await Promise.allSettled(newsFeeds.map(async ([source, feedUrl]) => {
        const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
        const feed = await getJson(endpoint);
        if (feed.status !== "ok") throw new Error(`${source} feed unavailable`);
        return (feed.items || []).slice(0, 5).map(item => ({ ...item, source }));
      }));
      const items = results.flatMap(result => result.status === "fulfilled" ? result.value : [])
        .sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)).slice(0, 5);
      newsBox.innerHTML = items.length ? items.map(item => feedItem(item.source, item)).join("") : '<div class="live-empty">News is temporarily unavailable.</div>';
    } catch (error) {
      console.warn("Landing news preview unavailable:", error.message);
      newsBox.innerHTML = '<div class="live-empty">News is temporarily unavailable. Visit the dashboard for more sources.</div>';
    }
  }

  void loadMarkets();
  void loadNews();
  setInterval(loadMarkets, 60000);
  setInterval(loadNews, 300000);
})();
