const WebSocket = require('ws');

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Thin wrapper around Solana's `logsSubscribe` websocket RPC method.
 * Watches one or more program IDs ("mentions" filter) and invokes a
 * callback with each matching log notification. Automatically reconnects
 * with exponential backoff if the socket drops, since long-running live
 * discovery needs to survive RPC provider hiccups without operator
 * intervention.
 */
class SolanaLogsSubscriber {
  constructor({
    wsUrl,
    programIds,
    onLogs,
    onError = () => {},
    onStatus = () => {},
    webSocketFactory = (url) => new WebSocket(url),
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS
  }) {
    if (!wsUrl) throw new Error('SolanaLogsSubscriber requires wsUrl');
    if (!Array.isArray(programIds) || programIds.length === 0) {
      throw new Error('SolanaLogsSubscriber requires at least one programId to watch');
    }
    this.wsUrl = wsUrl;
    this.programIds = programIds;
    this.onLogs = onLogs;
    this.onError = onError;
    this.onStatus = onStatus;
    this.webSocketFactory = webSocketFactory;
    this.baseReconnectDelayMs = reconnectDelayMs;
    this.currentReconnectDelayMs = reconnectDelayMs;
    this.socket = null;
    this.stopped = false;
    this.subscriptionIds = new Map();
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  connect() {
    if (this.stopped) return;
    this.onStatus({ state: 'connecting', wsUrl: this.wsUrl });
    const socket = this.webSocketFactory(this.wsUrl);
    this.socket = socket;

    socket.on('open', () => {
      this.currentReconnectDelayMs = this.baseReconnectDelayMs;
      this.onStatus({ state: 'open' });
      for (const programId of this.programIds) {
        this.subscribeToProgram(programId);
      }
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        this.onError(new Error(`Failed to parse websocket message: ${error.message}`));
        return;
      }
      if (message.method === 'logsNotification') {
        const subscriptionId = message.params?.subscription;
        const programId = this.subscriptionIds.get(subscriptionId);
        const value = message.params?.result?.value;
        if (value) {
          this.onLogs({ programId, signature: value.signature, logs: value.logs || [], err: value.err });
        }
        return;
      }
      if (typeof message.id === 'number' && message.result != null) {
        // Subscription confirmation: result is the subscription id, and we
        // stashed which programId this request corresponds to on send.
        const pendingProgramId = this.pendingRequests.get(message.id);
        if (pendingProgramId) {
          this.subscriptionIds.set(message.result, pendingProgramId);
          this.pendingRequests.delete(message.id);
        }
      }
    });

    socket.on('error', (error) => {
      this.onError(error);
    });

    socket.on('close', () => {
      this.onStatus({ state: 'closed' });
      this.subscriptionIds.clear();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    const delay = this.currentReconnectDelayMs;
    this.currentReconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => this.connect(), delay);
  }

  subscribeToProgram(programId) {
    const requestId = this.nextRequestId++;
    this.pendingRequests.set(requestId, programId);
    this.socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'logsSubscribe',
      params: [
        { mentions: [programId] },
        { commitment: 'confirmed' }
      ]
    }));
  }
}

module.exports = { SolanaLogsSubscriber };
