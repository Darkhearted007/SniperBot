const test = require('node:test');
const assert = require('node:assert/strict');

const { SolanaSafetyProvider, parseMintAccount } = require('../src/safety/onChainSafety');
const { runDeepSafetyChecks } = require('../src/safety/tokenSafety');
const { RISK_CONFIG } = require('../src/config/risk');

// Builds a minimal 82-byte SPL mint account buffer with configurable
// authority option flags so tests can simulate revoked/active authorities
// without needing a real chain.
function buildMintAccountBase64({ mintAuthorityActive, freezeAuthorityActive }) {
  const buffer = Buffer.alloc(82);
  buffer.writeUInt32LE(mintAuthorityActive ? 1 : 0, 0);
  buffer.writeUInt8(1, 45); // isInitialized
  buffer.writeUInt32LE(freezeAuthorityActive ? 1 : 0, 46);
  return buffer.toString('base64');
}

test('parseMintAccount reads authority flags from a mint account buffer', () => {
  const revoked = parseMintAccount(buildMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false }));
  assert.equal(revoked.mintAuthorityActive, false);
  assert.equal(revoked.freezeAuthorityActive, false);

  const active = parseMintAccount(buildMintAccountBase64({ mintAuthorityActive: true, freezeAuthorityActive: true }));
  assert.equal(active.mintAuthorityActive, true);
  assert.equal(active.freezeAuthorityActive, true);
});

function makeRpcFetchImpl(handlers) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body);
    const handler = handlers[body.method];
    if (!handler) {
      throw new Error(`No mock handler for RPC method ${body.method}`);
    }
    const result = handler(body.params);
    return {
      ok: true,
      async json() {
        return { jsonrpc: '2.0', id: body.id, result };
      }
    };
  };
}

test('checkMintAuthority reports revoked authorities as safe', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getAccountInfo: () => ({
      value: { data: [buildMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false }), 'base64'] }
    })
  });
  const provider = new SolanaSafetyProvider({ rpcUrl: 'https://rpc.example', fetchImpl });
  const result = await provider.checkMintAuthority('mint-1');
  assert.equal(result.mintAuthorityActive, false);
  assert.equal(result.freezeAuthorityActive, false);
});

test('checkHolderConcentration computes top-holder percentage from largest accounts', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getTokenLargestAccounts: () => ({
      value: [
        { address: 'whale-1', amount: '700' },
        { address: 'whale-2', amount: '200' },
        { address: 'whale-3', amount: '100' }
      ]
    })
  });
  const provider = new SolanaSafetyProvider({ rpcUrl: 'https://rpc.example', fetchImpl });
  const result = await provider.checkHolderConcentration('mint-1', { topN: 2 });
  assert.ok(Math.abs(result.topHolderPct - 0.9) < 1e-9);
  assert.equal(result.holderSampleSize, 3);
});

test('checkLpLockOrBurn recognizes a burned LP position', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getTokenLargestAccounts: () => ({
      value: [{ address: '1nc1nerator11111111111111111111111111111111', amount: '1000' }]
    })
  });
  const provider = new SolanaSafetyProvider({ rpcUrl: 'https://rpc.example', fetchImpl });
  const result = await provider.checkLpLockOrBurn('lp-mint-1');
  assert.equal(result.lpStatus, 'burned');
});

test('checkLpLockOrBurn flags an unlocked wallet-held LP position', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getTokenLargestAccounts: () => ({
      value: [{ address: 'dev-wallet', amount: '1000' }]
    }),
    getAccountInfo: () => ({ value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } })
  });
  const provider = new SolanaSafetyProvider({ rpcUrl: 'https://rpc.example', fetchImpl });
  const result = await provider.checkLpLockOrBurn('lp-mint-1');
  assert.equal(result.lpStatus, 'unlocked');
});

test('checkHoneypot flags tokens whose reverse quote fails as unsellable', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const provider = new SolanaSafetyProvider({ rpcUrl: 'https://rpc.example', fetchImpl, quoteApiBase: 'https://quote.example' });
  const result = await provider.checkHoneypot({ outputMint: 'mint-1', sellAmountRaw: '1000' });
  assert.equal(result.sellable, false);
});

test('runDeepSafetyChecks blocks entry when mint authority is still active', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getAccountInfo: () => ({
      value: { data: [buildMintAccountBase64({ mintAuthorityActive: true, freezeAuthorityActive: false }), 'base64'] }
    }),
    getTokenLargestAccounts: () => ({ value: [{ address: 'burn', amount: '1000' }] })
  });
  const provider = new SolanaSafetyProvider({
    rpcUrl: 'https://rpc.example',
    fetchImpl,
    burnAddresses: ['burn']
  });

  const opportunity = {
    tokenName: 'Test',
    symbol: 'TEST',
    liquidityUsd: 100000,
    rugScore: 0.05,
    momentumScore: 0.9,
    outputMint: 'mint-1',
    lpMint: 'lp-1'
  };

  const config = { ...RISK_CONFIG, honeypotSellCheck: false };
  const safety = await runDeepSafetyChecks(opportunity, config, provider);
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.includes('mint-authority-not-revoked'));
});

test('runDeepSafetyChecks passes a fully clean token', async () => {
  const fetchImpl = makeRpcFetchImpl({
    getAccountInfo: () => ({
      value: { data: [buildMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false }), 'base64'] }
    }),
    getTokenLargestAccounts: () => ({ value: [{ address: 'burn', amount: '1000' }] })
  });
  const provider = new SolanaSafetyProvider({
    rpcUrl: 'https://rpc.example',
    fetchImpl,
    burnAddresses: ['burn']
  });

  const opportunity = {
    tokenName: 'Test',
    symbol: 'TEST',
    liquidityUsd: 100000,
    rugScore: 0.05,
    momentumScore: 0.9,
    outputMint: 'mint-1',
    lpMint: 'lp-1'
  };

  const config = { ...RISK_CONFIG, honeypotSellCheck: false, maxTopHolderPct: 1 };
  const safety = await runDeepSafetyChecks(opportunity, config, provider);
  assert.equal(safety.safe, true);
  assert.deepEqual(safety.reasons, []);
});

test('runDeepSafetyChecks with no safetyProvider falls back to basic checks only', async () => {
  const opportunity = {
    tokenName: 'Test',
    symbol: 'TEST',
    liquidityUsd: 100000,
    rugScore: 0.05,
    momentumScore: 0.9
  };
  const safety = await runDeepSafetyChecks(opportunity, RISK_CONFIG, null);
  assert.equal(safety.safe, true);
  assert.equal(safety.onChain, null);
});
