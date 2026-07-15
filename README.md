# Signal Scanner Pro — JN Softs

A production-ready, mobile-first, dark-theme crypto technical-analysis and signal tool. **Pure HTML/CSS/vanilla JavaScript — no backend, no build step, no Node/PHP/Express.** Works by opening `index.html` directly, and deploys as-is to GitHub Pages.

## Project structure
```
index.html   — page structure
style.css    — dark glassmorphism theme, fully responsive
script.js    — data fetching, indicator math, signal engine, chart, history
README.md    — this file
```

## Data source
Live OHLC candles come from **Binance's public REST API** (`/api/v3/klines`, `/api/v3/ticker/24hr`) — no API key required. The app automatically retries across Binance's official mirror hosts (`api.binance.com`, `api1`, `api2`, `api3`, `data-api.binance.vision`) with per-request timeouts, so a single slow endpoint won't leave you stuck. It also checks `navigator.onLine` and gives specific status messages while connecting ("Checking Internet…", "Connecting Binance…", "Switching Backup Server…") instead of a bare "Failed to fetch".

If a symbol truly doesn't exist on Binance spot, you'll get a clear **"Invalid Symbol"** message rather than a silent failure — Binance's own market list is the source of truth, so double check a coin there first if unsure (binance.com → Markets).

## Coins
19 quick-select chips are pre-loaded (BTC, ETH, BNB, SOL, XRP, DOGE, ADA, LINK, SUI, PEPE, TRX, AVAX, APT, ARB, OP, INJ, FET, VANRY, 1000PEPE), plus a **custom coin box** — type any Binance spot pair (e.g. `EPICUSDT`) and it works exactly the same way. Chips are shortcuts, not a limit.

## Indicators computed client-side
EMA 20/50/200, RSI(14), MACD(12,26,9), ATR(14), ADX(14) with +DI/-DI, Supertrend(10,3), anchored VWAP, volume-vs-average, 20-bar support/resistance, breakout/breakdown detection, liquidity-sweep (wick trap) detection, and basic candlestick patterns (engulfing, doji).

## Signal engine
Each indicator contributes a weighted score (trend alignment counts most, momentum/volume/pattern confirmations add or subtract). The total maps to one of four signal types:

- **BUY LONG** / **SELL SHORT** — enough confirmations aligned in one direction
- **WAIT** — a lean in one direction, but not enough confirmations yet
- **NO TRADE** — mixed or range-bound conditions

Confidence % and tier (Weak / Medium / Strong / Very Strong) are derived directly from how many indicators agree — it's an honest heuristic score, **not a probability of profit**. Take-profit (TP1/TP2/TP3) and stop-loss levels are computed from ATR multiples off the live price, with a risk:reward ratio — standard technical reference levels, not guarantees.

## Telegram-style message
Every scan builds a copy-ready message in the exact requested format (Coin / Entry / Cross / Targets / Stop Loss / Risk Reward / Confidence / Timeframe / hashtag) with a one-click **Copy** button. The message includes a short "not financial advice" line — feel free to trim it in `script.js` (`buildTelegramMessage`) if you don't want it, but we'd recommend keeping some form of it if you're sharing signals with others.

## History, auto-refresh, notifications
- Signal history (last 100) lives in memory for the browser session — searchable, filterable by type, exportable to JSON, and clearable. (No `localStorage` is used by default so the app behaves identically whether opened locally, embedded, or deployed — add persistence yourself in `pushHistory()`/`renderHistory()` if you want it to survive a page reload.)
- Auto-refresh: 10s / 30s / 1min / 5min, toggle on/off.
- Browser notifications (opt-in via the 🔔 button) plus a short generated beep fire on new Strong/Very-Strong BUY or SELL signals.

## Chart
Candlesticks + EMA20/50/200 overlays + buy/sell markers render via **TradingView's lightweight-charts** library, loaded from a CDN at runtime (`unpkg.com`) — no local bundling needed. RSI and MACD histogram render on lightweight `<canvas>` panels below.

## Deploying to GitHub Pages
1. Push these four files to a repo (root, or a `/docs` folder).
2. Repo → Settings → Pages → set the source branch/folder.
3. Done — it's static, so it just works. No environment variables, no build command.

You can also drop `index.html`/`style.css`/`script.js` straight into a subfolder of an existing static site (e.g. as a new DocProTools tool page) — just make sure the `<script src="script.js">` and `<link href="style.css">` paths stay relative to wherever you place the files.

## Important
This tool performs rule-based technical analysis on historical price data. It does not predict the future, and the "confidence" score reflects indicator agreement, not certainty. Always apply your own risk management — this is not financial advice.
