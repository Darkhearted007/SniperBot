const { nowIso } = require('../utils/time');
const { createSupabaseClient } = require('../lib/supabase');

const DEFAULT_MAX_RECORDS = 5000;

class TradeLogger {
  constructor({ maxRecords = DEFAULT_MAX_RECORDS, supabase = null } = {}) {
    this.maxRecords = Number.isFinite(maxRecords) && maxRecords > 0
      ? Math.floor(maxRecords)
      : DEFAULT_MAX_RECORDS;
    this.records = [];
    this._supabase = supabase || null;
  }

  _enforceLimit() {
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  logDecision(payload) {
    const record = { type: 'decision', ts: nowIso(), ...payload };
    this.records.push(record);
    this._enforceLimit();

    // Async persist to Supabase (fire-and-forget)
    this._persistDecision(record).catch(() => {});
  }

  logExecution(payload) {
    const record = { type: 'execution', ts: nowIso(), ...payload };
    this.records.push(record);
    this._enforceLimit();

    // Async persist to Supabase (fire-and-forget)
    this._persistExecution(record).catch(() => {});
  }

  async _persistDecision(record) {
    if (!this._supabase) return;
    const { error } = await this._supabase.from('trade_decisions').insert({
      opportunity: record.opportunity || null,
      safety: record.safety || null,
      decision: record.decision || null,
      state: record.state || null,
      position: record.position || null,
      exit_decision: record.exitDecision || null,
      supervision: record.supervision || null,
      type: record.type || 'decision',
      created_at: record.ts || new Date().toISOString()
    });
    if (error) {
      console.warn('[tradeLogger] Supabase decision insert warning:', error.message);
    }
  }

  async _persistExecution(record) {
    if (!this._supabase) return;
    const { error } = await this._supabase.from('trade_executions').insert({
      kind: record.kind || 'unknown',
      opportunity: record.opportunity || null,
      position: record.position || null,
      execution: record.execution || null,
      decision: record.decision || null,
      exit_decision: record.exitDecision || null,
      supervision: record.supervision || null,
      created_at: record.ts || new Date().toISOString()
    });
    if (error) {
      console.warn('[tradeLogger] Supabase execution insert warning:', error.message);
    }
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
