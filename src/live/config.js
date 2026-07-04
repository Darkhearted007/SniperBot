const { DEFAULT_JUPITER_QUOTE_API, DEFAULT_JUPITER_SWAP_API, NATIVE_SOL_MINT } = require('./constants');

function parseOptionalNumber(value, fieldName) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  return parsed;
}

function parseRequiredJsonArray(value, fieldName) {
  if (!value) {
    throw new Error(`${fieldName} is required in live mode`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty JSON array`);
  }
  return parsed;
}

function normalizeWatchlistItem(item, index) {
  if (!item || typeof item !== 'object') {
    throw new Error(`SOLANA_WATCHLIST_JSON[${index}] must be an object`);
  }
  if (!item.outputMint || typeof item.outputMint !== 'string') {
    throw new Error(`SOLANA_WATCHLIST_JSON[${index}].outputMint is required`);
  }
  if (!item.symbol || typeof item.symbol !== 'string') {
    throw new Error(`SOLANA_WATCHLIST_JSON[${index}].symbol is required`);
  }
  const decimals = Number(item.decimals);
  // Live-mode price sampling and quantity calculations intentionally keep a
  // practical decimals cap because this bot converts sampled token amounts
  // through JavaScript number arithmetic and one-token quote sizing.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(
      `SOLANA_WATCHLIST_JSON[${index}].decimals must be an integer between 0 and 18 ` +
      'for this live-mode implementation'
    );
  }

  return {
    symbol: item.symbol,
    tokenName: item.tokenName || item.symbol,
    pair: item.pair || `SOL/${item.symbol}`,
    venue: item.venue || 'solana/jupiter',
    inputMint: item.inputMint || NATIVE_SOL_MINT,
    outputMint: item.outputMint,
    decimals,
    liquidityUsd: Number.isFinite(Number(item.liquidityUsd)) ? Number(item.liquidityUsd) : 0,
    rugScore: Number.isFinite(Number(item.rugScore)) ? Number(item.rugScore) : 1,
    baselineMomentumScore: Number.isFinite(Number(item.baselineMomentumScore))
      ? Number(item.baselineMomentumScore)
      : 0.65,
    volatilityRisk: Number.isFinite(Number(item.volatilityRisk))
      ? Number(item.volatilityRisk)
      : null
  };
}

function getTradingMode(env = process.env) {
  return String(env.TRADING_MODE || 'paper').toLowerCase();
}

function parseLiveTradingConfig(env = process.env) {
  const mode = getTradingMode(env);
  if (mode !== 'live') {
    return { mode: 'paper' };
  }

  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error('SOLANA_RPC_URL is required in live mode');
  }
  const walletSecret = env.SOLANA_WALLET_SECRET;
  if (!walletSecret) {
    throw new Error('SOLANA_WALLET_SECRET is required in live mode');
  }

  const watchlist = parseRequiredJsonArray(env.SOLANA_WATCHLIST_JSON, 'SOLANA_WATCHLIST_JSON')
    .map(normalizeWatchlistItem);

  const slippageBps = parseOptionalNumber(env.LIVE_SLIPPAGE_BPS, 'LIVE_SLIPPAGE_BPS') ?? 100;
  const pollIntervalMs = parseOptionalNumber(env.LIVE_POLL_INTERVAL_MS, 'LIVE_POLL_INTERVAL_MS') ?? 15_000;
  const minSolReserve = parseOptionalNumber(env.LIVE_MIN_SOL_RESERVE, 'LIVE_MIN_SOL_RESERVE') ?? 0.02;
  const maxBankrollSol = parseOptionalNumber(env.LIVE_MAX_BANKROLL_SOL, 'LIVE_MAX_BANKROLL_SOL');

  return {
    mode,
    rpcUrl,
    walletSecret,
    watchlist,
    quoteApiBase: env.JUPITER_QUOTE_API_BASE || DEFAULT_JUPITER_QUOTE_API,
    swapApiBase: env.JUPITER_SWAP_API_BASE || DEFAULT_JUPITER_SWAP_API,
    slippageBps,
    pollIntervalMs,
    minSolReserve,
    maxBankrollSol
  };
}

module.exports = { getTradingMode, parseLiveTradingConfig };
