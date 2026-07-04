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
}

module.exports = { TradeLogger };
