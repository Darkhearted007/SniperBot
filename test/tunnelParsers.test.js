const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNgrokTunnelsResponse, parseCloudflaredLogLine } = require('../scripts/tunnelParsers');

test('parseNgrokTunnelsResponse prefers the https tunnel when both http and https are present', () => {
  const body = JSON.stringify({
    tunnels: [
      { public_url: 'http://abcd-1234.ngrok-free.app', proto: 'http' },
      { public_url: 'https://abcd-1234.ngrok-free.app', proto: 'https' }
    ]
  });
  assert.equal(parseNgrokTunnelsResponse(body), 'https://abcd-1234.ngrok-free.app');
});

test('parseNgrokTunnelsResponse falls back to the first tunnel if none are https', () => {
  const body = JSON.stringify({ tunnels: [{ public_url: 'http://abcd-1234.ngrok-free.app', proto: 'http' }] });
  assert.equal(parseNgrokTunnelsResponse(body), 'http://abcd-1234.ngrok-free.app');
});

test('parseNgrokTunnelsResponse returns null for empty or malformed responses', () => {
  assert.equal(parseNgrokTunnelsResponse(JSON.stringify({ tunnels: [] })), null);
  assert.equal(parseNgrokTunnelsResponse('not json'), null);
  assert.equal(parseNgrokTunnelsResponse(undefined), null);
});

test('parseNgrokTunnelsResponse accepts an already-parsed object', () => {
  const parsed = { tunnels: [{ public_url: 'https://abcd-1234.ngrok-free.app' }] };
  assert.equal(parseNgrokTunnelsResponse(parsed), 'https://abcd-1234.ngrok-free.app');
});

test('parseCloudflaredLogLine extracts a trycloudflare.com URL from a boxed log line', () => {
  const line = '|  https://random-words-1234.trycloudflare.com                          |';
  assert.equal(parseCloudflaredLogLine(line), 'https://random-words-1234.trycloudflare.com');
});

test('parseCloudflaredLogLine returns null for unrelated log lines', () => {
  assert.equal(parseCloudflaredLogLine('INF Starting tunnel'), null);
  assert.equal(parseCloudflaredLogLine(''), null);
  assert.equal(parseCloudflaredLogLine(undefined), null);
});
