const { nowIso } = require('../utils/time');

const DEFAULT_MAX_RECORDS = 5000;

class TradeLogger {
  constructor({ maxRecords = DEFAULT_MAX_RECORDS } = {}) {
    this.maxRecords = Number.isFinite(maxRecords) && maxRecords > 0
      ? Math.floor(maxRecords)
      : DEFAULT_MAX_RECORDS;
    this.records = [];
  }

  _enforceLimit() {
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  logDecision(payload) {
    this.records.push({ type: 'decision', ts: nowIso(), ...payload });
    this._enforceLimit();
  }

  logExecution(payload) {
    this.records.push({ type: 'execution', ts: nowIso(), ...payload });
    this._enforceLimit();
  }

  all() {
    return this.records;
  }

  snapshot(maxRecords = null) {
    const limit = Number.isFinite(maxRecords) && maxRecords >= 1
      ? Math.floor(maxRecords)
      : this.maxRecords;
    return this.records.slice(-limit);
  }

  restore(records = []) {
    if (!Array.isArray(records)) return;
    this.records = records.slice(-this.maxRecords);
  }
}

module.exports = { TradeLogger };
