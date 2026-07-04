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
npm start
```

Dashboard endpoints:
- `GET /health`
- `GET /dashboard`

Authentication (one of):
1. Secret-key header:
   - Set `DASHBOARD_SECRET_KEY`
   - Send `x-secret-key`
2. Wallet-style challenge signature headers:
   - Set `WALLET_AUTH_SALT`
   - Send `x-wallet-address`, `x-wallet-challenge`, `x-wallet-signature`

## Test

```bash
npm test
```

## CI

GitHub Actions workflow at `.github/workflows/ci.yml` runs tests on push and pull requests.
