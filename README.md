# SniperBot

Strategic, learning-first sniper bot architecture for newly created pairs across:
- Solana/Raydium
- Solana/Pump.fun
- BSC (PancakeSwap-compatible feed)

This implementation is **paper-trading first** and starts simulation bankroll at **0.1 SOL**.

## Core capabilities

- Event-driven modular architecture:
  - Market opportunity feed
  - Token safety/risk checks
  - Strategy engine (entry/exit + confidence + dynamic TP/SL)
  - Paper execution engine
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
- `src/execution` – paper trade execution
- `src/learning` – logging + adaptive scoring
- `src/simulator` – orchestrated testable simulation
- `src/dashboard` – minimal authenticated dashboard API

## Run

```bash
npm install
DASHBOARD_SECRET_KEY=mysecret npm start
```

The bot runs a simulation loop and starts the dashboard API + web UI on port 3000 (configurable via `PORT`).

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

To get a permanent link your testers can open without cloning the repo:

```bash
cd mobile
npx expo login          # one-time Expo account login
npx expo publish        # publishes to exp.host
```

After publishing, Expo prints a URL like `exp://exp.host/@your-username/sniperbot-dashboard` — share that with testers.

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
