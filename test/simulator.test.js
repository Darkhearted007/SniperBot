const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildApp } = require('../src/index');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  if (!bytes.length) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += BASE58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function base64UrlToBuffer(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function createWalletIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const publicKeyBytes = base64UrlToBuffer(jwk.x);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    signMessage(message) {
      return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
    }
  };
}

test('paper simulator enters safe opportunities and logs reasoning', () => {
  const { simulator, logger } = buildApp();
  simulator.runCycle();

  assert.ok(simulator.state.openPositions.length > 0, 'expected at least one entered position');
  const decisions = logger.all().filter((r) => r.type === 'decision');
  assert.ok(decisions.some((d) => d.decision?.action === 'SKIP'), 'expected unsafe or low-edge skip');
  assert.ok(decisions.some((d) => d.decision?.action === 'ENTER'), 'expected an enter decision');
  assert.ok(decisions.some((d) => (d.decision?.reason || '').includes('liquidity-below-threshold')), 'expected safety reason in decision logs');
});

test('paper simulator exits position on take-profit and learns from outcome', () => {
  const { simulator, learning } = buildApp();
  simulator.runCycle();
  assert.ok(simulator.state.openPositions.length > 0, 'expected at least one open position after cycle');
  const before = simulator.state.realizedPnlSol;
  const forcedTakeProfitMap = Object.fromEntries(
    simulator.state.openPositions.map((position) => [position.pair, position.entryPrice * (1 + position.tpPct + 0.1)])
  );
  simulator.processMarketTick(forcedTakeProfitMap);

  assert.notEqual(simulator.state.realizedPnlSol, before, 'realized pnl should change after forced exits');
  assert.ok(learning.stats.wins + learning.stats.losses >= 1, 'learning should update stats after exit');
});

test('dashboard auth requires wallet session', async () => {
  const previousAllowedWallets = process.env.DASHBOARD_ALLOWED_WALLETS;
  const walletIdentity = createWalletIdentity();
  process.env.DASHBOARD_ALLOWED_WALLETS = walletIdentity.walletAddress;

  try {
    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
    const { createDashboardServer } = require('../src/dashboard/server');
    const { simulator, logger } = buildApp();
    const server = createDashboardServer({ simulator, logger });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const unauthorized = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(unauthorized.status, 401);

    const challengeRes = await fetch(
      `http://127.0.0.1:${port}/auth/challenge?wallet=${encodeURIComponent(walletIdentity.walletAddress)}`
    );
    assert.equal(challengeRes.status, 200);
    const challenge = await challengeRes.json();

    const verifyRes = await fetch(`http://127.0.0.1:${port}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: walletIdentity.walletAddress,
        signature: walletIdentity.signMessage(challenge.message)
      })
    });
    assert.equal(verifyRes.status, 200);
    const walletSession = await verifyRes.json();

    const walletAuth = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { authorization: ['Bearer', walletSession.token].join(' ') }
    });
    assert.equal(walletAuth.status, 200);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (previousAllowedWallets === undefined) delete process.env.DASHBOARD_ALLOWED_WALLETS;
    else process.env.DASHBOARD_ALLOWED_WALLETS = previousAllowedWallets;

    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
  }
});

test('dashboard auth rejects x-secret-key header', async () => {
  const previousAllowedWallets = process.env.DASHBOARD_ALLOWED_WALLETS;
  const walletIdentity = createWalletIdentity();
  process.env.DASHBOARD_ALLOWED_WALLETS = walletIdentity.walletAddress;

  try {
    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
    const { createDashboardServer } = require('../src/dashboard/server');
    const { simulator, logger } = buildApp();
    const server = createDashboardServer({ simulator, logger });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const secretAttempt = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { 'x-secret-key': 'any-value' }
    });
    assert.equal(secretAttempt.status, 401);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (previousAllowedWallets === undefined) delete process.env.DASHBOARD_ALLOWED_WALLETS;
    else process.env.DASHBOARD_ALLOWED_WALLETS = previousAllowedWallets;

    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
  }
});

test('dashboard exposes supervised decision endpoints when available', async () => {
  const previousAllowedWallets = process.env.DASHBOARD_ALLOWED_WALLETS;
  const walletIdentity = createWalletIdentity();
  process.env.DASHBOARD_ALLOWED_WALLETS = walletIdentity.walletAddress;

  try {
    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
    const { createDashboardServer } = require('../src/dashboard/server');
    const simulator = {
      state: {
        bankrollSol: 1,
        realizedPnlSol: 0,
        openPositions: [],
        dailyLossPct: 0,
        drawdownPct: 0,
        circuitBreaker: false
      },
      getPendingDecisions() {
        return [{ id: 'decision-1', kind: 'enter' }];
      },
      getDecisionHistory() {
        return [{ id: 'decision-0', status: 'rejected' }];
      },
      getActiveWatchlist() {
        return [{ symbol: 'BONK', pair: 'SOL/BONK' }];
      },
      async approvePendingDecision(id) {
        return { id, signature: 'sig-1' };
      },
      rejectPendingDecision(id, reason) {
        return { id, reason: reason || 'manually-rejected' };
      }
    };
    const server = createDashboardServer({
      simulator,
      logger: { all() { return []; } },
      goalAgent: null,
      variantAgent: null
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    // Obtain a wallet session token
    const challengeRes = await fetch(
      `http://127.0.0.1:${port}/auth/challenge?wallet=${encodeURIComponent(walletIdentity.walletAddress)}`
    );
    const challenge = await challengeRes.json();
    const verifyRes = await fetch(`http://127.0.0.1:${port}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: walletIdentity.walletAddress,
        signature: walletIdentity.signMessage(challenge.message)
      })
    });
    const { token } = await verifyRes.json();
    const authHeader = { authorization: 'Bearer ' + token };

    const pending = await fetch(`http://127.0.0.1:${port}/pending-decisions`, {
      headers: authHeader
    });
    assert.equal(pending.status, 200);
    const pendingJson = await pending.json();
    assert.equal(pendingJson.pendingDecisions.length, 1);

    const approved = await fetch(`http://127.0.0.1:${port}/decisions/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ id: 'decision-1' })
    });
    assert.equal(approved.status, 200);

    const rejected = await fetch(`http://127.0.0.1:${port}/decisions/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ id: 'decision-1', reason: 'operator-rejected' })
    });
    assert.equal(rejected.status, 200);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (previousAllowedWallets === undefined) delete process.env.DASHBOARD_ALLOWED_WALLETS;
    else process.env.DASHBOARD_ALLOWED_WALLETS = previousAllowedWallets;
    const serverModPath = require.resolve('../src/dashboard/server');
    delete require.cache[serverModPath];
  }
});
