const { nowIso } = require('../utils/time');

class TradeLogger {
  constructor() {
    this.records = [];
  }

  logDecision(payload) {
    this.records.push({ type: 'decision', ts: nowIso(), ...payload });
  }

  logExecution(payload) {
    this.records.push({ type: 'execution', ts: nowIso(), ...payload });
  }

  all() {
    return this.records;
  }

  snapshot(maxRecords = null) {
    if (!Number.isFinite(maxRecords) || maxRecords < 1) {
      return [...this.records];
    }
    return this.records.slice(-Math.floor(maxRecords));
  }

  restore(records = []) {
    if (!Array.isArray(records)) return;
    this.records = [...records];
  }
}

module.exports = { TradeLogger };
