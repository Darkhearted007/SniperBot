#!/bin/bash
set -a
# ── Mode ──
TRADING_MODE=paper
PORT=3000
DASHBOARD_SECRET_KEY=devpreview

# ── RPC ──
SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=4b57cfd8-d4ce-4ee4-9d27-be254ac0a06f"
SOLANA_WS_URL="wss://mainnet.helius-rpc.com/?api-key=4b57cfd8-d4ce-4ee4-9d27-be254ac0a06f"

# ── Wallet ──
SOLANA_WALLET_SECRET="[150,108,122,30,196,48,82,130,215,212,235,129,26,75,24,247,108,240,226,64,94,110,186,42,71,189,197,185,249,216,59,117,169,127,232,234,163,248,247,124,16,70,87,130,39,204,78,252,89,187,126,135,214,23,227,207,37,156,7,28,249,248,209,158]"

# ── Watchlist ──
SOLANA_WATCHLIST_JSON='[{"symbol":"JUP","tokenName":"Jupiter","outputMint":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","decimals":6,"liquidityUsd":50000000,"rugScore":0.05},{"symbol":"BONK","tokenName":"Bonk","outputMint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6Yo81Bp1PB263yPB263","decimals":5,"liquidityUsd":30000000,"rugScore":0.10},{"symbol":"WIF","tokenName":"dogwifhat","outputMint":"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm","decimals":6,"liquidityUsd":20000000,"rugScore":0.10},{"symbol":"PYTH","tokenName":"Pyth Network","outputMint":"HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3","decimals":6,"liquidityUsd":15000000,"rugScore":0.05},{"symbol":"RENDER","tokenName":"Render","outputMint":"rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4DaaqT4F2bL","decimals":6,"liquidityUsd":10000000,"rugScore":0.08}]'

# ── Safety ──
LIVE_REQUIRE_SUPERVISION=true
LIVE_REQUIRE_ONCHAIN_SAFETY=true
LIVE_MIN_SOL_RESERVE=0.05
LIVE_MAX_BANKROLL_SOL=0.25
LIVE_SLIPPAGE_BPS=100
LIVE_POLL_INTERVAL_MS=15000
SAFETY_CACHE_TTL_MS=60000

# ── Pool Discovery ──
LIVE_POOL_DISCOVERY=true

# ── State ──
BOT_STATE_FILE=./sniperbot-state.json
BOT_STATE_PERSIST_EVERY_CYCLES=10

set +a

echo "Starting SniperBot in $TRADING_MODE mode..."
node src/index.js
