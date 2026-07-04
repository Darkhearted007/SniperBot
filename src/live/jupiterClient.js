const { DEFAULT_JUPITER_QUOTE_API, DEFAULT_JUPITER_SWAP_API } = require('./constants');

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

async function readJson(response) {
  const body = await response.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (_) {
    parsed = { raw: body };
  }
  if (!response.ok) {
    const message = parsed.error || parsed.message || parsed.raw || `HTTP ${response.status}`;
    throw new Error(`Jupiter API error: ${message}`);
  }
  return parsed;
}

async function fetchJupiterQuote({
  fetchImpl = fetch,
  quoteApiBase = DEFAULT_JUPITER_QUOTE_API,
  inputMint,
  outputMint,
  amount,
  slippageBps,
  swapMode = 'ExactIn'
}) {
  const url = new URL(`${trimTrailingSlash(quoteApiBase)}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('swapMode', swapMode);

  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' }
  });
  const quote = await readJson(response);
  if (!quote.outAmount || !quote.inAmount) {
    throw new Error('Jupiter quote response missing inAmount/outAmount');
  }
  return quote;
}

async function fetchJupiterSwap({
  fetchImpl = fetch,
  swapApiBase = DEFAULT_JUPITER_SWAP_API,
  quoteResponse,
  userPublicKey
}) {
  const response = await fetchImpl(`${trimTrailingSlash(swapApiBase)}/swap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    })
  });
  const swap = await readJson(response);
  if (!swap.swapTransaction) {
    throw new Error('Jupiter swap response missing swapTransaction');
  }
  return swap;
}

module.exports = { fetchJupiterQuote, fetchJupiterSwap };
