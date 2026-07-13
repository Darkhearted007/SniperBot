/**
 * MemoryStore — Long-term trade memory for the Agent Council.
 *
 * Every completed trade (entry + exit) is stored as a lifelong record.
 * The store continuously mines patterns across multiple dimensions:
 *  - Venue performance
 *  - Momentum/volatility bands
 *  - Market regime (bull/chop/bear)
 *  - Confidence ranges
 *  - Liquidity buckets
 *
 * It extracts "lessons" — specific rules like:
 *   "momentum < 0.6 + volatility > 0.3 + bear_regime = 80% loss rate → avoid"
 *
 * These lessons are surfaced during Agent Council meetings so every agent
 * can learn from past failures and reinforce winning strategies.
 */

const MAX_TRADE_MEMORY = 2000;
const MIN_TRADES_FOR_LESSON = 3;
const MIN_LOSS_RATE_FOR_WARNING = 0.65;
const MIN_WIN_RATE_FOR_REINFORCE = 0.75;

class MemoryStore {
  constructor() {
    /** @type {Array<object>} Every completed trade with full context */
    this.trades = [];

    /** @type {Array<{lesson: string, category: string, strength: number, createdAt: string}>} */
    this.lessons = [];

    /** @type {object} Aggregated pattern buckets */
    this.patterns = {
      byVenue: {},
      byMomentumBand: { low: { wins: 0, losses: 0, totalPnl: 0 }, mid: { wins: 0, losses: 0, totalPnl: 0 }, high: { wins: 0, losses: 0, totalPnl: 0 } },
      byVolatilityBand: { low: { wins: 0, losses: 0, totalPnl: 0 }, mid: { wins: 0, losses: 0, totalPnl: 0 }, high: { wins: 0, losses: 0, totalPnl: 0 } },
      byRegime: { bull: { wins: 0, losses: 0, totalPnl: 0 }, chop: { wins: 0, losses: 0, totalPnl: 0 }, bear: { wins: 0, losses: 0, totalPnl: 0 } },
      byConfidenceBand: { low: { wins: 0, losses: 0, totalPnl: 0 }, mid: { wins: 0, losses: 0, totalPnl: 0 }, high: { wins: 0, losses: 0, totalPnl: 0 } },
      byExitReason: {}
    };

    // Track combined dimensions for deeper pattern mining
    this._comboPatterns = {};
  }

  /**
   * Record a completed trade with full context.
   * Called when an exit execution is logged.
   */
  recordTrade(trade) {
    const record = {
      id: trade.positionId || `${trade.symbol}-${Date.now()}`,
      symbol: trade.symbol,
      venue: trade.venue,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pnlSol: trade.pnlSol,
      pnlPct: trade.pnlPct,
      exitReason: trade.exitReason || 'unknown',
      confidence: trade.confidence,
      expectedEdge: trade.expectedEdge,
      riskAdjustedScore: trade.riskAdjustedScore,
      momentumScore: trade.momentumScore,
      volatilityRisk: trade.volatilityRisk,
      liquidityUsd: trade.liquidityUsd,
      trendState: trade.trendState,
      volatilityRegime: trade.volatilityRegime,
      tokenCategory: trade.tokenCategory,
      sizeSol: trade.sizeSol,
      isWin: trade.pnlPct > 0,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt || new Date().toISOString(),
      durationMs: trade.durationMs || 0
    };

    this.trades.push(record);
    if (this.trades.length > MAX_TRADE_MEMORY) {
      this.trades = this.trades.slice(-MAX_TRADE_MEMORY);
    }

    // Update all pattern buckets
    this._updatePatterns(record);
    this._updateComboPatterns(record);
    this._extractLessons(record);
  }

  /**
   * Get all completed trades (read-only snapshot).
   */
  getAllTrades() {
    return this.trades;
  }

  /**
   * Get recent trades within a window.
   */
  getRecentTrades(count = 50) {
    return this.trades.slice(-count);
  }

  /**
   * Get overall statistics.
   */
  getStats() {
    const total = this.trades.length;
    if (total === 0) {
      return { totalTrades: 0, winRate: 0, avgPnlPct: 0, totalPnlSol: 0, consecutiveLosses: 0 };
    }
    const wins = this.trades.filter((t) => t.isWin).length;
    const totalPnl = this.trades.reduce((s, t) => s + t.pnlSol, 0);
    const avgPnl = this.trades.reduce((s, t) => s + t.pnlPct, 0) / total;

    // Consecutive losses (most recent streak)
    let consecutiveLosses = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      if (this.trades[i].isWin) break;
      consecutiveLosses++;
    }

    return {
      totalTrades: total,
      winRate: wins / total,
      avgPnlPct: avgPnl,
      totalPnlSol: totalPnl,
      consecutiveLosses,
      allTimeHighEquity: this._allTimeHighEquity
    };
  }

  /**
   * Get extracted lessons (actionable insights from past trades).
   */
  getLessons() {
    return this.lessons.map((l) => ({
      ...l,
      age: Date.now() - new Date(l.createdAt).getTime()
    }));
  }

  /**
   * Get pattern summary for council report.
   */
  getPatternReport() {
    const fmt = (pct) => typeof pct === 'number' ? Number((pct * 100).toFixed(1)) + '%' : 'N/A';

    const summarize = (bucket) => {
      const total = bucket.wins + bucket.losses;
      if (total === 0) return { total: 0, winRate: 'N/A', avgPnl: 'N/A' };
      return {
        total,
        winRate: fmt(bucket.wins / total),
        avgPnl: (bucket.totalPnl / total).toFixed(4) + ' SOL'
      };
    };

    const venueSummary = {};
    for (const [venue, v] of Object.entries(this.patterns.byVenue)) {
      venueSummary[venue] = summarize(v);
    }

    return {
      totalTrades: this.trades.length,
      lessonsCount: this.lessons.length,
      byVenue: venueSummary,
      byMomentumBand: Object.fromEntries(
        Object.entries(this.patterns.byMomentumBand).map(([k, v]) => [k, summarize(v)])
      ),
      byVolatilityBand: Object.fromEntries(
        Object.entries(this.patterns.byVolatilityBand).map(([k, v]) => [k, summarize(v)])
      ),
      byRegime: Object.fromEntries(
        Object.entries(this.patterns.byRegime).map(([k, v]) => [k, summarize(v)])
      ),
      byConfidenceBand: Object.fromEntries(
        Object.entries(this.patterns.byConfidenceBand).map(([k, v]) => [k, summarize(v)])
      ),
      byExitReason: Object.fromEntries(
        Object.entries(this.patterns.byExitReason).map(([k, v]) => [k, summarize(v)])
      )
    };
  }

  /**
   * Generate a strategic proposal based on accumulated memory.
   * This is what the CouncilAgent uses to form new strategies.
   */
  generateProposal() {
    const proposals = [];
    const report = this.getPatternReport();
    const stats = this.getStats();

    // 1. If a venue has >60% loss rate with significant trades → avoid it
    for (const [venue, summary] of Object.entries(report.byVenue)) {
      if (summary.total >= MIN_TRADES_FOR_LESSON && summary.winRate !== 'N/A') {
        const wr = parseFloat(summary.winRate) / 100;
        if (wr < 0.4) {
          proposals.push({
            type: 'avoid-venue',
            target: venue,
            reason: `${venue} has ${summary.winRate} win rate over ${summary.total} trades`,
            severity: wr < 0.25 ? 'critical' : 'warning'
          });
        } else if (wr > MIN_WIN_RATE_FOR_REINFORCE) {
          proposals.push({
            type: 'prioritize-venue',
            target: venue,
            reason: `${venue} has ${summary.winRate} win rate over ${summary.total} trades`,
            severity: 'positive'
          });
        }
      }
    }

    // 2. Momentum band analysis
    const momentum = report.byMomentumBand;
    if (momentum.high.total >= MIN_TRADES_FOR_LESSON) {
      const highWR = parseFloat(momentum.high.winRate) / 100;
      const lowWR = momentum.low.winRate !== 'N/A' ? parseFloat(momentum.low.winRate) / 100 : 0;
      if (highWR > MIN_WIN_RATE_FOR_REINFORCE && lowWR < MIN_LOSS_RATE_FOR_WARNING) {
        proposals.push({
          type: 'raise-min-momentum',
          target: 'minMomentumScore',
          value: 0.65,
          reason: `High momentum (>0.75) has ${momentum.high.winRate} win rate while low momentum has ${momentum.low.winRate}`,
          severity: 'positive'
        });
      }
    }

    // 3. Regime-based strategy suggestion
    const regime = report.byRegime;
    for (const [reg, summary] of Object.entries(regime)) {
      if (summary.total >= MIN_TRADES_FOR_LESSON && summary.winRate !== 'N/A') {
        const wr = parseFloat(summary.winRate) / 100;
        if (wr < 0.35) {
          proposals.push({
            type: 'regime-caution',
            target: reg,
            reason: `${reg} regime has only ${summary.winRate} win rate — reduce position size or increase edge threshold`,
            severity: wr < 0.2 ? 'critical' : 'warning'
          });
        } else if (wr > 0.8) {
          proposals.push({
            type: 'regime-aggression',
            target: reg,
            reason: `${reg} regime has ${summary.winRate} win rate — increase position size`,
            severity: 'positive'
          });
        }
      }
    }

    // 4. Exit reason analysis
    const exitReasons = report.byExitReason;
    for (const [reason, summary] of Object.entries(exitReasons)) {
      if (summary.total >= 3 && summary.winRate !== 'N/A') {
        const wr = parseFloat(summary.winRate) / 100;
        if (reason === 'stop-loss' && wr < 1) {
          proposals.push({
            type: 'widen-stop-loss',
            target: 'stopLossBasePct',
            value: 0.10,
            reason: `${summary.total} stop-loss exits with ${summary.winRate} win rate — stops may be too tight`,
            severity: 'warning'
          });
        } else if (reason === 'trailing-stop' && wr > 0.7) {
          proposals.push({
            type: 'reinforce-trailing-stop',
            target: 'trailActivatePct',
            reason: `Trailing stops are profitable (${summary.winRate}) — keep aggressive trailing`,
            severity: 'positive'
          });
        }
      }
    }

    // 5. Consecutive loss warning
    if (stats.consecutiveLosses >= 5) {
      proposals.push({
        type: 'consecutive-losses',
        target: 'circuitBreaker',
        reason: `${stats.consecutiveLosses} consecutive losses detected — consider pausing or reducing size`,
        severity: 'critical'
      });
    }

    return {
      proposals,
      timestamp: new Date().toISOString(),
      tradeCount: stats.totalTrades,
      overallWinRate: Number((stats.winRate * 100).toFixed(1)) + '%',
      consecutiveLosses: stats.consecutiveLosses
    };
  }

  snapshot() {
    return {
      trades: this.trades.slice(-500), // Keep last 500 for serialization efficiency
      lessons: this.lessons.slice(-100),
      patterns: this.patterns,
      _comboPatterns: this._comboPatterns
    };
  }

  restore(snapshot = {}) {
    if (Array.isArray(snapshot.trades)) {
      this.trades = snapshot.trades;
    }
    if (Array.isArray(snapshot.lessons)) {
      this.lessons = snapshot.lessons;
    }
    if (snapshot.patterns && typeof snapshot.patterns === 'object') {
      // Deep merge patterns
      this._deepMerge(this.patterns, snapshot.patterns);
    }
    if (snapshot._comboPatterns && typeof snapshot._comboPatterns === 'object') {
      this._comboPatterns = snapshot._comboPatterns;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────

  _updatePatterns(record) {
    const update = (bucket, isWin, pnl) => {
      if (isWin) bucket.wins += 1;
      else bucket.losses += 1;
      bucket.totalPnl += pnl;
    };

    // By venue
    if (!this.patterns.byVenue[record.venue]) {
      this.patterns.byVenue[record.venue] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    update(this.patterns.byVenue[record.venue], record.isWin, record.pnlSol);

    // By momentum band
    const momBand = record.momentumScore >= 0.75 ? 'high' : record.momentumScore >= 0.5 ? 'mid' : 'low';
    update(this.patterns.byMomentumBand[momBand], record.isWin, record.pnlSol);

    // By volatility band
    const volBand = record.volatilityRisk >= 0.35 ? 'high' : record.volatilityRisk >= 0.18 ? 'mid' : 'low';
    update(this.patterns.byVolatilityBand[volBand], record.isWin, record.pnlSol);

    // By regime
    if (record.trendState && this.patterns.byRegime[record.trendState]) {
      update(this.patterns.byRegime[record.trendState], record.isWin, record.pnlSol);
    }

    // By confidence
    const conf = record.confidence || 0.5;
    const confBand = conf >= 0.7 ? 'high' : conf >= 0.4 ? 'mid' : 'low';
    update(this.patterns.byConfidenceBand[confBand], record.isWin, record.pnlSol);

    // By exit reason
    const reason = record.exitReason || 'unknown';
    if (!this.patterns.byExitReason[reason]) {
      this.patterns.byExitReason[reason] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    update(this.patterns.byExitReason[reason], record.isWin, record.pnlSol);
  }

  _updateComboPatterns(record) {
    // Track combined dimensions for deeper pattern mining
    // e.g. "momentum < 0.6 + bear regime + low liquidity"
    const momKey = record.momentumScore >= 0.75 ? 'high_mom' : record.momentumScore >= 0.5 ? 'mid_mom' : 'low_mom';
    const volKey = record.volatilityRisk >= 0.35 ? 'high_vol' : record.volatilityRisk >= 0.18 ? 'mid_vol' : 'low_vol';
    const regimeKey = record.trendState || 'unknown';
    const comboKey = `${momKey}|${volKey}|${regimeKey}|${record.venue}`;

    if (!this._comboPatterns[comboKey]) {
      this._comboPatterns[comboKey] = { wins: 0, losses: 0, totalPnl: 0, count: 0, avgPnlPct: 0 };
    }
    const cp = this._comboPatterns[comboKey];
    cp.count += 1;
    if (record.isWin) cp.wins += 1;
    else cp.losses += 1;
    cp.totalPnl += record.pnlSol;
    cp.avgPnlPct = (cp.avgPnlPct * (cp.count - 1) + record.pnlPct) / cp.count;
  }

  _extractLessons(record) {
    // Mine every combo pattern for actionable lessons
    for (const [comboKey, data] of Object.entries(this._comboPatterns)) {
      if (data.count >= MIN_TRADES_FOR_LESSON) {
        const lossRate = data.losses / data.count;
        const winRate = data.wins / data.count;

        if (lossRate >= MIN_LOSS_RATE_FOR_WARNING) {
          const [mom, vol, regime, venue] = comboKey.split('|');
          const lessonText = `AVOID: ${mom}|${vol}|${regime}|${venue} — ${(lossRate * 100).toFixed(0)}% loss rate over ${data.count} trades (avg PnL: ${(data.avgPnlPct * 100).toFixed(1)}%)`;
          this._addLesson(lessonText, 'danger-zone', lossRate);
        }

        if (winRate >= MIN_WIN_RATE_FOR_REINFORCE && data.count >= 5) {
          const [mom, vol, regime, venue] = comboKey.split('|');
          const lessonText = `PRIORITIZE: ${mom}|${vol}|${regime}|${venue} — ${(winRate * 100).toFixed(0)}% win rate over ${data.count} trades (avg PnL: ${(data.avgPnlPct * 100).toFixed(1)}%)`;
          this._addLesson(lessonText, 'sweet-spot', winRate);
        }
      }
    }
  }

  _addLesson(text, category, strength) {
    // Deduplicate: don't add the same lesson text twice
    const exists = this.lessons.some((l) => l.lesson === text);
    if (!exists) {
      this.lessons.push({
        lesson: text,
        category,
        strength: Number(strength.toFixed(2)),
        createdAt: new Date().toISOString()
      });
      // Keep only most recent 200 lessons
      if (this.lessons.length > 200) {
        this.lessons = this.lessons.slice(-200);
      }
    }
  }

  _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this._deepMerge(target[key], source[key]);
      } else if (source[key] !== undefined) {
        target[key] = source[key];
      }
    }
  }
}

module.exports = { MemoryStore };
