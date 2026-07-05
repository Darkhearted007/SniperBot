# SniperBot

Strategic, learning-first sniper bot architecture for newly created pairs across:
- Solana/Raydium
- Solana/Pump.fun
- BSC (PancakeSwap-compatible feed)

This implementation is **paper-trading first** and starts simulation bankroll at **0.1 SOL**.
It also includes an **opt-in Solana live-trading mode** for a curated Solana universe with optional automated watchlist selection and supervised execution.

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
  - Simple dashboard API with real Solana wallet sessions or secret-key auth
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

The bot starts the dashboard API + web UI on port 3000 (configurable via `PORT`) and now runs continuously until you stop it (for example with `Ctrl+C` / `SIGTERM`).

### Startup and shutdown

- Start: `DASHBOARD_SECRET_KEY=mysecret npm start`
- Graceful stop: `Ctrl+C` (SIGINT) or `kill <pid>` (SIGTERM)
- Shutdown behavior: current cycle finishes, server closes, then process exits cleanly.
- Health check: `GET /health` (requires dashboard auth header/session).

## Live Solana trading

> **Warning**
> Live mode sends real on-chain swaps from your wallet. Use a dedicated wallet and start with a very small bankroll cap.

Live mode is disabled by default. Enable it with `TRADING_MODE=live`.

### Required environment variables

- `TRADING_MODE=live`
- `SOLANA_RPC_URL` – Solana RPC HTTPS endpoint
- `SOLANA_WALLET_SECRET` – wallet secret as a 64-byte JSON array or base64-encoded 64-byte keypair
- `SOLANA_WATCHLIST_JSON` – JSON array of tokens to monitor directly
- `SOLANA_AUTO_WATCHLIST_JSON` – optional JSON array of candidate tokens for automatic watchlist selection
- each watchlist item should use a practical token `decimals` value between `0` and `18`

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
DASHBOARD_ALLOWED_WALLETS=YourOperatorWalletBase58 \
DASHBOARD_SECRET_KEY=mysecret \
npm start
```

### Optional environment variables

- `LIVE_POLL_INTERVAL_MS` – default `15000`
- `PAPER_CYCLE_DELAY_MS` – paper-mode delay between cycles (ms), default `0` (as fast as possible)
- `PAPER_AUTO_STOP_ON_GOAL` – if true, paper mode stops when goal/deadline is hit; default `false` for long-running operation
- `LIVE_MIN_SOL_RESERVE` – default `0.02`
- `LIVE_MAX_BANKROLL_SOL` – optional cap for strategy sizing
- `LIVE_AUTO_WATCHLIST_SIZE` – top candidate count to keep in the active watchlist
- `LIVE_REQUIRE_SUPERVISION` – require manual approval before live entries and exits are executed
- `LIVE_SLIPPAGE_BPS` – default `100`
- `BOT_STATE_FILE` – optional JSON snapshot path for persisted learning/trade state across restarts
- `BOT_STATE_PERSIST_EVERY_CYCLES` – snapshot cadence for live loops, default `10`
- `DASHBOARD_ALLOWED_WALLETS` – comma-separated Solana wallet addresses allowed to sign in to the dashboard
- `DASHBOARD_CHALLENGE_TTL_MS` – wallet sign-in challenge lifetime, default `300000`
- `DASHBOARD_SESSION_TTL_MS` – wallet session lifetime, default `43200000`
- `JUPITER_QUOTE_API_BASE`
- `JUPITER_SWAP_API_BASE`
- `LIVE_REQUIRE_ONCHAIN_SAFETY` – enable the on-chain safety pipeline (see below); default `false`
- `SAFETY_CACHE_TTL_MS` – how long computed on-chain safety results are cached per mint, default `60000`
- `LIVE_POOL_DISCOVERY` – enable real-time new-pool/pair discovery (see below); default `false`
- `SOLANA_WS_URL` – Solana websocket RPC endpoint, required when `LIVE_POOL_DISCOVERY=true`
- `POOL_DISCOVERY_PROGRAMS` – comma-separated program IDs to watch; defaults to Raydium AMM v4, Raydium CPMM, and Pump.fun
- `POOL_DISCOVERY_MAX_CANDIDATES` – rolling cap on discovered candidates kept in memory, default `25`

### Live-mode behavior

- Live mode is currently **Solana only**
- It can trade a fixed watchlist or automatically rank a configured candidate list into an active watchlist each cycle
- Quotes and swap transactions are requested from Jupiter
- Entry decisions now include execution-quality gating (expected slippage, depth, failure-rate checks) and portfolio exposure limits
- The bot expects a dedicated SOL-funded wallet; pre-existing token holdings are not imported into bot state
- `SOLANA_WATCHLIST_JSON` should include `liquidityUsd` and `rugScore`; missing values default to conservative safety values and will usually block entries
- Supervised mode queues entry and exit decisions until an authenticated operator approves or rejects them through the dashboard API
- Each watchlist item can optionally include `lpMint` (the pool's LP token mint) to enable the LP lock/burn check described below

### On-chain safety pipeline

Set `LIVE_REQUIRE_ONCHAIN_SAFETY=true` to have every live entry pass through `SolanaSafetyProvider` (`src/safety/onChainSafety.js`) before the strategy is allowed to act on it. This replaces trust in a hand-typed `rugScore` with real checks:

- **Mint/freeze authority** – blocks tokens where the mint or freeze authority hasn't been renounced (the deployer could still mint unlimited supply or freeze your holdings). Toggle with `requireMintAuthorityRevoked` / `requireFreezeAuthorityRevoked` in `src/config/risk.js`.
- **Holder concentration** – uses `getTokenLargestAccounts` to flag tokens where a small number of wallets hold a large share of the largest-holder sample. Threshold: `maxTopHolderPct`.
- **LP lock/burn** – if a watchlist item provides `lpMint`, checks whether the largest holder of the LP token is a burn address or a known locker program vs. a wallet the deployer could drain from. Threshold: `requireLpLockedOrBurned`.
- **Honeypot / sell simulation** – fetches a reverse Jupiter quote (token → SOL) before entering; if the sell leg fails, the token is blocked. Toggle: `honeypotSellCheck`.

Results are cached per mint for `SAFETY_CACHE_TTL_MS` to avoid re-querying the RPC/quote API every cycle for tokens already evaluated.

**Limitations, stated plainly:** this raises the bar but isn't a rug-proof guarantee. `getTokenLargestAccounts` only returns the largest holders it tracks (not a full supply census), LP-lock detection only runs when `lpMint` is known (auto-discovered pools usually won't have this yet), and the honeypot check catches simple sell-blocking, not sophisticated delayed traps. Paper mode is unaffected — it keeps using the fast synchronous heuristic checks only.

### Real-time pool/pair discovery

Set `LIVE_POOL_DISCOVERY=true` (with `SOLANA_WS_URL` set) to have the bot watch Raydium and Pump.fun program logs for new pool/token creation in real time, instead of relying only on a hand-maintained `SOLANA_AUTO_WATCHLIST_JSON`:

- `PoolDiscoveryFeed` (`src/market/poolDiscoveryFeed.js`) subscribes to program logs via `logsSubscribe` over websocket, and on a matching creation-instruction log, fetches the full transaction and diffs `preTokenBalances`/`postTokenBalances` to identify newly-appeared mints — this is more robust than decoding instruction accounts by position, which varies across program versions.
- Discovered tokens are added to a rolling, capped candidate list (`POOL_DISCOVERY_MAX_CANDIDATES`) with a conservative default `rugScore` of `1` (maximum risk) — actual risk is determined later by the on-chain safety pipeline above before any entry is placed.
- Candidates merge with (and don't replace) any static `SOLANA_AUTO_WATCHLIST_JSON` entries, then get ranked by `SolanaWatchlistFeed` like any other candidate.
- The websocket client auto-reconnects with exponential backoff if the RPC provider drops the connection.

**Limitations:** the creation-log markers (`initialize2` for Raydium AMM v4, `Instruction: Create` for Pump.fun, etc.) are string matches against human-readable program logs, not a binary instruction decode — if a venue upgrades its program, these may need updating. Discovered candidates also won't have an `lpMint` set automatically, so the LP lock/burn check reports `unknown` for them until that's wired up with a pool-address resolver.

## Adaptive optimization model

- Strategy selection uses a risk-adjusted score (growth + drawdown + stability) instead of raw equity only.
- Pattern recommendations (best momentum/liquidity bands) are automatically fed back into strategy thresholds.
- The default paper feed now rotates through dynamic trend/volatility regimes and includes execution-quality context fields.

## Web Dashboard

Open **`http://localhost:3000/`** in any browser after starting the bot.

On first visit a connection dialog appears — enter:
- **Server URL** – `http://localhost:3000` (or your machine's LAN IP for remote access)
- **Secret Key** – optional fallback using `DASHBOARD_SECRET_KEY`
- Or leave the key blank and approve the sign-in request from an allowed Solana wallet (for example Phantom)

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

### GitHub Actions deploys (preview + production)

This repository includes a dedicated workflow at `.github/workflows/vercel-deploy.yml`:

- Pull requests to `main` trigger a **preview** deployment
- Pushes to `main` (and manual dispatch) trigger a **production** deployment

Configure these repository secrets before using the workflow:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

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
| `GET` | `/pending-decisions` | ✓ | Pending supervised trade decisions + recent approval history |
| `POST` | `/decisions/approve` | ✓ | Approve a pending supervised decision |
| `POST` | `/decisions/reject` | ✓ | Reject a pending supervised decision |

Authentication (one of):
1. Secret-key header:
   - Set `DASHBOARD_SECRET_KEY`
   - Send `x-secret-key: <key>`
2. Wallet challenge + session flow:
   - Set `DASHBOARD_ALLOWED_WALLETS` to the operator wallets that may access the dashboard
   - Request `GET /auth/challenge?wallet=<base58-wallet>`
   - Sign the returned message with the wallet
   - Exchange it at `POST /auth/verify` for a bearer token
   - Send the bearer token in the `Authorization` header on subsequent dashboard API requests

## Test

```bash
npm test
```

## Troubleshooting startup and early exits

- If the process exits during startup, check structured logs for `fatal-startup-error`.
- In live mode, missing required env vars (`SOLANA_RPC_URL`, `SOLANA_WALLET_SECRET`, and watchlist config) fail fast with actionable errors.
- In paper mode, ensure `PAPER_CYCLE_DELAY_MS` is a non-negative number.
- Runtime failures now log as structured events (`live-cycle-failed` / `paper-cycle-failed`) with retry/backoff context.

## CI

GitHub Actions workflow at `.github/workflows/ci.yml` runs tests on push and pull requests.
