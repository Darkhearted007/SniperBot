/**
 * CouncilAgent — The Agent Council meeting room.
 *
 * Every N cycles, the CouncilAgent convenes a "meeting" where:
 *   1. Each agent submits a performance report
 *   2. The MemoryStore contributes pattern analysis and lessons learned
 *   3. The Council debates (computes) what strategy to adopt
 *   4. Strategic directives are emitted for the Orchestrator to implement
 *   5. A debrief summary is logged for all agents to reference
 *
 * The Council's mandate: achieve ZERO losses and MAXIMUM profits.
 * Every meeting focuses on identifying loss patterns and eliminating them.
 */

const MEETING_INTERVAL_CYCLES = 10;
const CRITICAL_MEETING_INTERVAL = 3; // If consecutive losses > threshold, meet more often
const MAX_CONSECUTIVE_LOSSES_BEFORE_INTERVENTION = 5;

class CouncilAgent {
  constructor({ memoryStore, goalAgent, patternAgent, variantAgent, config }) {
    this.memoryStore = memoryStore;
    this.goalAgent = goalAgent;
    this.patternAgent = patternAgent;
    this.variantAgent = variantAgent;
    this.config = config;

    this.totalMeetingsHeld = 0;
    this.lastMeetingCycle = 0;
    this.activeDirectives = [];
    this.meetingHistory = [];
    this._interventionMode = false;
  }

  /**
   * Determine if a council meeting is due this cycle.
   * Meetings happen every MEETING_INTERVAL_CYCLES, or more frequently
   * when consecutive losses trigger intervention mode.
   */
  shouldConvene(cycle, consecutiveLosses) {
    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES_BEFORE_INTERVENTION) {
      this._interventionMode = true;
      return (cycle - this.lastMeetingCycle) >= CRITICAL_MEETING_INTERVAL;
    }
    this._interventionMode = false;
    return (cycle - this.lastMeetingCycle) >= MEETING_INTERVAL_CYCLES;
  }

  /**
   * Convene a full council meeting. Returns directives for the Orchestrator.
   *
   * @param {object}  mainState     - Current main simulator state
   * @param {number}  cycle         - Current cycle number
   * @param {Array}   recentLogs    - Recent trade logs
   */
  convene(mainState, cycle, recentLogs = []) {
    this.totalMeetingsHeld += 1;
    this.lastMeetingCycle = cycle;

    // 1. Collect reports from every agent
    const goalReport = this._collectGoalReport(mainState);
    const variantReport = this._collectVariantReport();
    const patternReport = this._collectPatternReport();
    const memoryReport = this._collectMemoryReport();

    // 2. Generate strategic proposals from accumulated memory
    const memoryProposal = this.memoryStore.generateProposal();

    // 3. Cross-reference: do different agents agree on the same issues?
    const consensus = this._findConsensus(goalReport, variantReport, patternReport, memoryProposal);

    // 4. Produce actionable directives
    const directives = this._produceDirectives(goalReport, consensus, memoryProposal, mainState);

    // 5. Build the meeting record
    const meetingRecord = {
      meetingNumber: this.totalMeetingsHeld,
      cycle,
      timestamp: new Date().toISOString(),
      interventionMode: this._interventionMode,
      goalReport,
      variantReport,
      patternReport,
      memoryReport,
      memoryProposal,
      consensus,
      directives,
      stateSnapshot: {
        bankrollSol: mainState.bankrollSol,
        realizedPnlSol: mainState.realizedPnlSol,
        openPositions: (mainState.openPositions || []).length,
        circuitBreaker: mainState.circuitBreaker
      }
    };

    this.meetingHistory.push(meetingRecord);
    if (this.meetingHistory.length > 50) {
      this.meetingHistory = this.meetingHistory.slice(-50);
    }

    this.activeDirectives = directives;

    return {
      meetingId: this.totalMeetingsHeld,
      directives,
      consensus,
      interventionMode: this._interventionMode,
      summary: this._buildSummary(meetingRecord)
    };
  }

  /**
   * Get the current set of active directives.
   */
  getActiveDirectives() {
    return this.activeDirectives;
  }

  /**
   * Get meeting history for dashboard display.
   */
  getMeetingHistory() {
    return this.meetingHistory.map((m) => ({
      meetingNumber: m.meetingNumber,
      cycle: m.cycle,
      timestamp: m.timestamp,
      interventionMode: m.interventionMode,
      directivesCount: m.directives.length,
      consensusPoints: m.consensus.length,
      summary: this._buildSummary(m)
    }));
  }

  snapshot() {
    return {
      totalMeetingsHeld: this.totalMeetingsHeld,
      lastMeetingCycle: this.lastMeetingCycle,
      activeDirectives: this.activeDirectives,
      meetingHistory: this.meetingHistory.slice(-20),
      _interventionMode: this._interventionMode
    };
  }

  restore(snapshot = {}) {
    if (typeof snapshot.totalMeetingsHeld === 'number') this.totalMeetingsHeld = snapshot.totalMeetingsHeld;
    if (typeof snapshot.lastMeetingCycle === 'number') this.lastMeetingCycle = snapshot.lastMeetingCycle;
    if (Array.isArray(snapshot.activeDirectives)) this.activeDirectives = snapshot.activeDirectives;
    if (Array.isArray(snapshot.meetingHistory)) this.meetingHistory = snapshot.meetingHistory;
    if (typeof snapshot._interventionMode === 'boolean') this._interventionMode = snapshot._interventionMode;
  }

  // ─── Private report collectors ──────────────────────────────────

  _collectGoalReport(mainState) {
    const status = this.goalAgent.checkGoal(mainState);
    return {
      goalSol: status.goalSol,
      equity: status.equity,
      progress: status.progress,
      achieved: status.achieved,
      expired: status.expired,
      timeRemainingMs: status.timeRemainingMs,
      assessment: status.progress > 0.5 ? 'on-track' : status.progress > 0.2 ? 'needs-acceleration' : 'behind-schedule'
    };
  }

  _collectVariantReport() {
    const summary = this.variantAgent.getSummary();
    return {
      variants: summary.map((v) => ({
        name: v.name,
        winRate: v.winRate,
        avgPnlPct: v.avgPnlPct,
        equity: v.equity,
        circuitBreaker: v.circuitBreaker,
        riskAdjustedScore: v.riskAdjustedScore
      })),
      recommendation: summary.length > 0 ? summary[0].name : 'balanced'
    };
  }

  _collectPatternReport() {
    const patterns = this.patternAgent.getDeepPatterns
      ? this.patternAgent.getDeepPatterns()
      : { recentWinRate: 0, recentTradeCount: 0, suggestions: [] };

    return patterns;
  }

  _collectMemoryReport() {
    const stats = this.memoryStore.getStats();
    const lessons = this.memoryStore.getLessons();
    return {
      totalTrades: stats.totalTrades,
      winRate: Number((stats.winRate * 100).toFixed(1)) + '%',
      avgPnlPct: Number((stats.avgPnlPct * 100).toFixed(2)) + '%',
      totalPnlSol: stats.totalPnlSol,
      consecutiveLosses: stats.consecutiveLosses,
      recentLessons: lessons.slice(-10).map((l) => ({
        lesson: l.lesson,
        category: l.category,
        strength: l.strength
      }))
    };
  }

  _findConsensus(goalReport, variantReport, patternReport, memoryProposal) {
    const consensus = [];

    // Check: do multiple sources agree the bot should be more aggressive/defensive?
    const isGoalBehind = goalReport.assessment === 'behind-schedule';
    const isGoalOnTrack = goalReport.assessment === 'on-track';
    const hasLossStreak = memoryProposal.consecutiveLosses >= 3;
    const bestVariantWinRate = variantReport.variants.length > 0 ? variantReport.variants[0].winRate : 0;

    if (isGoalBehind && bestVariantWinRate > 0.6) {
      consensus.push({
        topic: 'aggression-needed',
        confidence: 0.8,
        sources: ['goal', 'variant'],
        message: 'Goal is behind schedule but strategy is winning — increase position sizing'
      });
    }

    if (hasLossStreak && isGoalOnTrack) {
      consensus.push({
        topic: 'defensive-shift',
        confidence: 0.7,
        sources: ['memory', 'goal'],
        message: 'Profit target is within reach — tighten risk controls to protect gains'
      });
    }

    if (hasLossStreak && memoryProposal.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES_BEFORE_INTERVENTION) {
      consensus.push({
        topic: 'intervention-required',
        confidence: 0.95,
        sources: ['memory', 'pattern'],
        message: `${memoryProposal.consecutiveLosses} consecutive losses — council intervention mode activated`
      });
    }

    // Check critical proposals from memory
    const criticalProposals = memoryProposal.proposals.filter((p) => p.severity === 'critical');
    if (criticalProposals.length > 0) {
      consensus.push({
        topic: 'critical-warnings',
        confidence: 0.9,
        sources: ['memory'],
        message: criticalProposals.map((p) => p.reason).join('; ')
      });
    }

    return consensus;
  }

  _produceDirectives(goalReport, consensus, memoryProposal, mainState) {
    const directives = [];

    // Apply memory proposals as directives
    for (const proposal of memoryProposal.proposals) {
      if (proposal.severity === 'critical' || proposal.severity === 'warning') {
        directives.push({
          id: `dir-${Date.now()}-${directives.length}`,
          type: proposal.type,
          target: proposal.target,
          value: proposal.value,
          reason: proposal.reason,
          severity: proposal.severity,
          createdAt: new Date().toISOString()
        });
      }
      if (proposal.severity === 'positive') {
        directives.push({
          id: `dir-${Date.now()}-${directives.length}`,
          type: proposal.type,
          target: proposal.target,
          value: proposal.value,
          reason: proposal.reason,
          severity: 'positive',
          createdAt: new Date().toISOString()
        });
      }
    }

    // Apply consensus-based directives
    for (const c of consensus) {
      if (c.topic === 'intervention-required') {
        directives.push({
          id: `dir-${Date.now()}-intervention`,
          type: 'intervention-mode',
          target: 'circuitBreaker',
          value: true,
          reason: c.message,
          severity: 'critical',
          createdAt: new Date().toISOString()
        });
      }
      if (c.topic === 'aggression-needed' && c.confidence > 0.7) {
        directives.push({
          id: `dir-${Date.now()}-aggression`,
          type: 'increase-position-size',
          target: 'maxPositionPct',
          value: Math.min(0.25, (this.config.maxPositionPct || 0.15) * 1.3),
          reason: c.message,
          severity: 'positive',
          createdAt: new Date().toISOString()
        });
      }
      if (c.topic === 'defensive-shift' && c.confidence > 0.6) {
        directives.push({
          id: `dir-${Date.now()}-defensive`,
          type: 'tighten-risk',
          target: 'maxPositionPct',
          value: Math.max(0.05, (this.config.maxPositionPct || 0.15) * 0.7),
          reason: c.message,
          severity: 'warning',
          createdAt: new Date().toISOString()
        });
      }
    }

    return directives;
  }

  _buildSummary(meetingRecord) {
    const criticalCount = meetingRecord.directives.filter((d) => d.severity === 'critical').length;
    const warningCount = meetingRecord.directives.filter((d) => d.severity === 'warning').length;
    const positiveCount = meetingRecord.directives.filter((d) => d.severity === 'positive').length;

    let verdict = '✅ All clear — no critical issues';
    if (criticalCount > 0) verdict = `⛔ ${criticalCount} critical directive(s) — intervention active`;
    else if (warningCount > 0) verdict = `⚠️ ${warningCount} warning(s) — proceed with caution`;

    return {
      meetingNumber: meetingRecord.meetingNumber,
      cycle: meetingRecord.cycle,
      directivesCount: meetingRecord.directives.length,
      criticalDirectives: criticalCount,
      warningDirectives: warningCount,
      positiveDirectives: positiveCount,
      interventionMode: meetingRecord.interventionMode,
      consensusCount: meetingRecord.consensus.length,
      goalProgress: Number((meetingRecord.goalReport.progress * 100).toFixed(1)) + '%',
      memoryWinRate: meetingRecord.memoryReport.winRate,
      memoryTrades: meetingRecord.memoryReport.totalTrades,
      variantRecommended: meetingRecord.variantReport.recommendation,
      verdict
    };
  }
}

module.exports = { CouncilAgent };
