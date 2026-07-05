const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runMain } = require('../src/index');
const SIGNAL_EMIT_DELAY_MS = 20;

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
  const runtime = new EventEmitter();
  runtime.exitCode = 0;
  const runPromise = runMain({
    TRADING_MODE: 'paper',
    PAPER_CYCLE_DELAY_MS: '1',
    PORT: '0',
    DASHBOARD_SECRET_KEY: 'test-secret'
  }, runtime);

  setTimeout(() => {
    runtime.emit('SIGTERM', 'SIGTERM');
  }, SIGNAL_EMIT_DELAY_MS);

  await assert.doesNotReject(runPromise);
});
