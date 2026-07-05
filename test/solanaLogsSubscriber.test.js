const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { SolanaLogsSubscriber } = require('../src/live/solanaLogsSubscriber');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.emit('close');
  }
}

test('SolanaLogsSubscriber subscribes to each program on open and routes notifications by subscription id', () => {
  let socket;
  const received = [];
  const subscriber = new SolanaLogsSubscriber({
    wsUrl: 'wss://example.invalid',
    programIds: ['program-a', 'program-b'],
    onLogs: (event) => received.push(event),
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    }
  });

  subscriber.start();
  socket.emit('open');

  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[0].method, 'logsSubscribe');
  assert.deepEqual(socket.sent[0].params[0].mentions, ['program-a']);

  // Simulate the RPC confirming subscription ids for each request.
  socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: socket.sent[0].id, result: 111 }));
  socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: socket.sent[1].id, result: 222 }));

  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription: 222,
      result: { value: { signature: 'sig-1', logs: ['Program log: test'], err: null } }
    }
  }));

  assert.equal(received.length, 1);
  assert.equal(received[0].programId, 'program-b');
  assert.equal(received[0].signature, 'sig-1');
});

test('SolanaLogsSubscriber reconnects after the socket closes unexpectedly', async () => {
  let connectCount = 0;
  const sockets = [];
  const subscriber = new SolanaLogsSubscriber({
    wsUrl: 'wss://example.invalid',
    programIds: ['program-a'],
    onLogs: () => {},
    reconnectDelayMs: 1,
    webSocketFactory: () => {
      connectCount += 1;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  });

  subscriber.start();
  sockets[0].emit('open');
  sockets[0].emit('close');

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connectCount, 2);
  subscriber.stop();
});
