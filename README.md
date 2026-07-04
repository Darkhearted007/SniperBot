# SniperBot

Strategic, learning-first sniper bot architecture for newly created pairs across:
- Solana/Raydium
- Solana/Pump.fun
- BSC (PancakeSwap-compatible feed)

This implementation is **paper-trading first** and starts simulation bankroll at **0.1 SOL**.
It also includes an **opt-in Solana live-trading mode** for a manually curated watchlist.

[![Deploy Dashboard to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Darkhearted007/SniperBot)

## Core capabilities

- Event-driven modular architecture:
  - Market opportunity feed
  - Token safety/risk checks
  - Strategy engine (entry/exit + confidence + dynamic TP/SL)
  - Paper execution engine
  - Solana live execution engine
  - Learning engine
  - Decision/execution logging
  - Simple dashboard API with wallet or secret-key auth
- Risk guardrails:
  - Position sizing cap
  - Drawdown and daily loss fail-safes
  - Duplicate position prevention
  - Liquidity/rug filters
- Test coverage validates:
  - Entry/skip behavior
  - Exit behavior and learning updates
  - Decision logging
  - Dashboard authentication modes

## Project structure

- `src/config` – risk and venue constraints
- `src/market` – opportunity discovery feed
- `src/safety` – token safety screening
- `src/strategy` – decision logic and exits
- `src/execution` – paper and live trade execution
- `src/learning` – logging + adaptive scoring
- `src/simulator` – orchestrated testable simulation
- `src/live` – Solana live-mode config and RPC helpers
- `src/dashboard` – minimal authenticated dashboard API

## Run

```bash
npm install
DASHBOARD_SECRET_KEY=mysecret npm start
```

The bot runs a simulation loop and starts the dashboard API + web UI on port 3000 (configurable via `PORT`).

## Live Solana trading

> **Warning**
> Live mode sends real on-chain swaps from your wallet. Use a dedicated wallet and start with a very small bankroll cap.

Live mode is disabled by default. Enable it with `TRADING_MODE=live`.

### Required environment variables

- `TRADING_MODE=live`
- `SOLANA_RPC_URL` – Solana RPC HTTPS endpoint
- `SOLANA_WALLET_SECRET` – wallet secret as a 64-byte JSON array or base64-encoded 64-byte keypair
- `SOLANA_WATCHLIST_JSON` – JSON array of tokens to monitor

Example:

```bash
TRADING_MODE=live \
SOLANA_RPC_URL=https://your-rpc.example \
SOLANA_WALLET_SECRET='[12,34,...]' \
SOLANA_WATCHLIST_JSON='[
  {
    "symbol":"BONK",
    "tokenName":"Bonk",
    "outputMint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6YaB1pPB263yPB263",
    "decimals":5,
    "liquidityUsd":1000000,
    "rugScore":0.15
  }
]' \
LIVE_MIN_SOL_RESERVE=0.05 \
LIVE_MAX_BANKROLL_SOL=0.25 \
LIVE_SLIPPAGE_BPS=100 \
DASHBOARD_SECRET_KEY=mysecret \
npm start
```

### Optional environment variables

- `LIVE_POLL_INTERVAL_MS` – default `15000`
- `LIVE_MIN_SOL_RESERVE` – default `0.02`
- `LIVE_MAX_BANKROLL_SOL` – optional cap for strategy sizing
- `LIVE_SLIPPAGE_BPS` – default `100`
- `JUPITER_QUOTE_API_BASE`
- `JUPITER_SWAP_API_BASE`

### Live-mode behavior

- Live mode is currently **Solana only**
- It trades a **manual watchlist**, not automatic new-pair discovery
- Quotes and swap transactions are requested from Jupiter
- The bot expects a dedicated SOL-funded wallet; pre-existing token holdings are not imported into bot state
- `SOLANA_WATCHLIST_JSON` should include `liquidityUsd` and `rugScore`; missing values default to conservative safety values and will usually block entries

## Web Dashboard

Open **`http://localhost:3000/`** in any browser after starting the bot.

On first visit a connection dialog appears — enter:
- **Server URL** – `http://localhost:3000` (or your machine's LAN IP for remote access)
- **Secret Key** – the value of `DASHBOARD_SECRET_KEY`

The dashboard auto-refreshes every 3 seconds and shows:
- Goal progress bar (0.1 → 2.0 SOL)
- Bankroll, realized PnL, circuit-breaker status
- Drawdown and daily-loss risk gauges
- Strategy variant performance table
- Open positions and recent trade logs

## Mobile Dashboard (Expo Go)

A React Native app in `mobile/` lets testers monitor the bot from any iOS or Android device using [Expo Go](https://expo.dev/go).

### Setup

```bash
cd mobile
npm install
npx expo start
```

Expo will print a QR code in the terminal. Scan it with:
- **iOS**: the Camera app
- **Android**: the Expo Go app

### First launch

Enter the bot's **Server URL** using your machine's local IP address (not `localhost`), e.g.:

```
http://192.168.1.42:3000
```

> Tip: find your machine's LAN IP with `ipconfig` (Windows) or `ifconfig` / `ip addr` (macOS/Linux).

### Publish a shareable Expo Go link

To get a permanent link your testers can open without cloning the repo, use [EAS Update](https://docs.expo.dev/eas-update/getting-started/):

```bash
cd mobile
npm install -g eas-cli     # install the EAS CLI once
npx eas login              # log in to your Expo account
npx eas update --branch production --message "initial release"
```

After publishing, EAS prints a shareable URL that testers can open directly in Expo Go.

Alternatively, for quick local sharing during development, run `npx expo start` and share the printed QR code or the `exp://` URL with testers on the same network.

## Hosting the dashboard on Vercel

The web dashboard (`src/dashboard/index.html`) is a fully static file — no server required. You can host it on Vercel so testers can reach it from any device without running the bot locally.

### One-click deploy

Click the button at the top of this README, or go to:

```
https://vercel.com/new/clone?repository-url=https://github.com/Darkhearted007/SniperBot
```

Vercel will clone the repo, run `npm run build` (which copies `src/dashboard/index.html` → `public/index.html`), and publish the result.

### Manual deploy via CLI

```bash
npm install -g vercel   # install the Vercel CLI once
vercel login
vercel --prod
```

### After deploying

1. Open your Vercel URL (e.g. `https://sniperbot-dashboard.vercel.app`)
2. The settings modal opens automatically — enter:
   - **Server URL**: the public address of your running bot  
     (e.g. `https://your-vps.example.com:3000` or your ngrok URL)
   - **Secret Key**: the value of `DASHBOARD_SECRET_KEY`
3. Click **Connect** — the dashboard starts polling your bot in real time

> **Note:** The bot itself (simulation loop + API) must run on a persistent host such as a VPS, home server, or a tunnel like [ngrok](https://ngrok.com/) / [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/). Vercel only hosts the static UI.

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | ✗ public | Web dashboard UI |
| `GET` | `/health` | ✓ | Liveness check |
| `GET` | `/dashboard` | ✓ | Core simulator state + recent logs |
| `GET` | `/agents` | ✓ | Goal status + variant summary |
| `GET` | `/summary` | ✓ | Combined data (used by web & mobile dashboards) |

Authentication (one of):
1. Secret-key header:
   - Set `DASHBOARD_SECRET_KEY`
   - Send `x-secret-key: <key>`
2. Wallet-style challenge signature headers:
   - Set `WALLET_AUTH_SALT`
   - Send `x-wallet-address`, `x-wallet-challenge`, `x-wallet-signature`

## Test

```bash
npm test
```

## CI

GitHub Actions workflow at `.github/workflows/ci.yml` runs tests on push and pull requests.
