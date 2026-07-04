const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/index');

function fixedChallengeSig(wallet, challenge, salt) {
  const crypto = require('node:crypto');
  return crypto.createHmac('sha256', salt).update(`${wallet}:${challenge}`).digest('hex');
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
  const before = simulator.state.realizedPnlSol;
  simulator.processMarketTick({ 'SOL/NEW1': 0.022, 'BNB/NEW3': 0.03 });

  assert.notEqual(simulator.state.realizedPnlSol, before, 'realized pnl should change after forced exits');
  assert.ok(learning.stats.wins + learning.stats.losses >= 1, 'learning should update stats after exit');
});

test('dashboard auth supports secret key and wallet-style signature', async () => {
  const previousSecret = process.env.DASHBOARD_SECRET_KEY;
  const previousSalt = process.env.WALLET_AUTH_SALT;
  process.env.DASHBOARD_SECRET_KEY = 'abc123';
  process.env.WALLET_AUTH_SALT = 'salt';

  try {
    const { createDashboardServer } = require('../src/dashboard/server');
    const { simulator, logger } = buildApp();
    const server = createDashboardServer({ simulator, logger });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const unauthorized = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(unauthorized.status, 401);

    const secretAuth = await fetch(`http://127.0.0.1:${port}/dashboard`, { headers: { 'x-secret-key': 'abc123' } });
    assert.equal(secretAuth.status, 200);

    const wallet = 'wallet1';
    const challenge = 'nonce';
    const sig = fixedChallengeSig(wallet, challenge, 'salt');
    const walletAuth = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: {
        'x-wallet-address': wallet,
        'x-wallet-challenge': challenge,
        'x-wallet-signature': sig
      }
    });
    assert.equal(walletAuth.status, 200);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (previousSecret === undefined) delete process.env.DASHBOARD_SECRET_KEY;
    else process.env.DASHBOARD_SECRET_KEY = previousSecret;

    if (previousSalt === undefined) delete process.env.WALLET_AUTH_SALT;
    else process.env.WALLET_AUTH_SALT = previousSalt;
  }
});
