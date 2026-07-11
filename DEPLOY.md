# 🚀 Deploy SniperBot to Railway

## Prerequisites

- Your code pushed to GitHub (`git push origin main`)
- A [Railway account](https://railway.app) (free tier works)

---

## Step 1: Create a Railway Project

1. Go to [railway.app](https://railway.app) and log in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `SniperBot` repository
4. Railway auto-detects Node.js and uses `railway.toml` for config

---

## Step 2: Set Environment Variables

In the Railway dashboard, go to your project → **Variables** tab. Add all of these:

### Core Mode
| Variable | Value | Notes |
|----------|-------|-------|
| `TRADING_MODE` | `paper` | Start with paper! Switch to `live` later |
| `DASHBOARD_SECRET_KEY` | `devpreview` | Use this to access the dashboard |

### Solana RPC (Your Helius)
| Variable | Value |
|----------|-------|
| `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=4b57cfd8-d4ce-4ee4-9d27-be254ac0a06f` |
| `SOLANA_WS_URL` | `wss://mainnet.helius-rpc.com/?api-key=4b57cfd8-d4ce-4ee4-9d27-be254ac0a06f` |

### Wallet (only for live mode — skip for paper)
| Variable | Value |
|----------|-------|
| `SOLANA_WALLET_SECRET` | `[150,108,122,...full 64-byte array...]` |

### Watchlist (Tokens to monitor)
| Variable | Value |
|----------|-------|
| `SOLANA_WATCHLIST_JSON` | `[{"symbol":"JUP",...},...]` |

### Safety Guardrails
| Variable | Value |
|----------|-------|
| `LIVE_REQUIRE_SUPERVISION` | `true` |
| `LIVE_REQUIRE_ONCHAIN_SAFETY` | `true` |
| `LIVE_MIN_SOL_RESERVE` | `0.05` |
| `LIVE_MAX_BANKROLL_SOL` | `0.25` |
| `LIVE_SLIPPAGE_BPS` | `100` |
| `LIVE_POLL_INTERVAL_MS` | `15000` |
| `SAFETY_CACHE_TTL_MS` | `60000` |

### Pool Discovery (optional)
| Variable | Value |
|----------|-------|
| `LIVE_POOL_DISCOVERY` | `true` |

### State Persistence
| Variable | Value |
|----------|-------|
| `BOT_STATE_FILE` | `./sniperbot-state.json` |
| `BOT_STATE_PERSIST_EVERY_CYCLES` | `10` |

---

## Step 3: Deploy

Railway deploys automatically when you push to GitHub. To trigger a manual deploy:

```
git commit --allow-empty -m "deploy: trigger railway build"
git push origin main
```

Or click **Deploy** in the Railway dashboard.

---

## Step 4: Access the Dashboard

Once deployed, Railway assigns a public URL like:

```
https://sniperbot.up.railway.app
```

Open that URL in your browser and enter:
- **Server URL**: `https://sniperbot.up.railway.app` (your Railway URL)
- **Secret Key**: `devpreview` (or whatever you set `DASHBOARD_SECRET_KEY` to)

---

## Switching to Live Mode

When you're ready to trade live:

1. Fund the wallet: `CQf2TBVCtKAjJw1mEGpEYPVn7MUgGJ87wP4esHJhftsF`
2. In Railway dashboard → **Variables**, change `TRADING_MODE=live`
3. Railway auto-restarts the app

> ⚠️ Always test in paper mode first. Live mode sends real SOL transactions.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Health check failing | Ensure `/ping` returns `{"ok":true}` — already configured in `railway.toml` |
| "No open positions" | Normal in paper mode — the synthetic feed creates random token data |
| Wallet balance too low | Send more SOL to the wallet address |
| WebSocket disconnects | Check `SOLANA_WS_URL` is correct with `wss://` prefix |
