const { randomUUID } = require('node:crypto');

class TradeApprovalQueue {
  constructor() {
    this.pending = new Map();
    this.pendingByKey = new Map();
    this.history = [];
  }

  upsert({ key, kind, opportunity = null, decision = null, position = null, exitDecision = null }) {
    const now = new Date().toISOString();
    const existingId = this.pendingByKey.get(key);
    if (existingId) {
      const existing = this.pending.get(existingId);
      const updated = {
        ...existing,
        opportunity,
        decision,
        position,
        exitDecision,
        updatedAt: now
      };
      this.pending.set(existingId, updated);
      return updated;
    }

    const item = {
      id: randomUUID(),
      key,
      kind,
      opportunity,
      decision,
      position,
      exitDecision,
      createdAt: now,
      updatedAt: now
    };
    this.pending.set(item.id, item);
    this.pendingByKey.set(key, item.id);
    return item;
  }

  getPending(id) {
    return this.pending.get(id) || null;
  }

  listPending() {
    return [...this.pending.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listHistory() {
    return this.history;
  }

  resolve(id, status, metadata = {}) {
    const item = this.pending.get(id);
    if (!item) {
      throw new Error(`Pending decision ${id} was not found`);
    }

    this.pending.delete(id);
    this.pendingByKey.delete(item.key);

    const resolved = {
      ...item,
      status,
      resolvedAt: new Date().toISOString(),
      ...metadata
    };
    this.history = [resolved, ...this.history].slice(0, 100);
    return resolved;
  }

  reject(id, reason = 'manually-rejected') {
    return this.resolve(id, 'rejected', { reason });
  }
}

module.exports = { TradeApprovalQueue };
