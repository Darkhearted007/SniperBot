const test = require('node:test');
const assert = require('node:assert/strict');

const { runMain } = require('../src/index');

test('runMain validates PAPER_CYCLE_DELAY_MS as non-negative', async () => {
  await assert.rejects(
    runMain({
      TRADING_MODE: 'paper',
      PAPER_CYCLE_DELAY_MS: '-1',
      PORT: '0',
      DASHBOARD_SECRET_KEY: 'test-secret'
    }),
    /PAPER_CYCLE_DELAY_MS must be a non-negative number/
  );
});

test('runMain handles SIGTERM with graceful shutdown in paper mode', async () => {
  const runPromise = runMain({
    TRADING_MODE: 'paper',
    PAPER_CYCLE_DELAY_MS: '1',
    PORT: '0',
    DASHBOARD_SECRET_KEY: 'test-secret'
  });

  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 20);

  await assert.doesNotReject(runPromise);
});
