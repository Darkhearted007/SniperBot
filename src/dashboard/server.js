const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function safeEqual(a, b) {
  const aBuf = Buffer.from(a || '');
  const bBuf = Buffer.from(b || '');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function createDashboardServer({ simulator, logger, goalAgent, variantAgent }) {
  const secret = (process.env.DASHBOARD_SECRET_KEY || '').trim() || undefined;
  const walletSalt = (process.env.WALLET_AUTH_SALT || '').trim() || undefined;

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'x-secret-key, x-wallet-address, x-wallet-challenge, x-wallet-signature, content-type'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  function auth(req) {
    const secretHeader = req.headers['x-secret-key'];
    let decodedHeader;
    try { decodedHeader = secretHeader ? decodeURIComponent(secretHeader) : secretHeader; }
    catch (_) { decodedHeader = secretHeader; } // malformed percent-encoding: compare as-is (will fail auth)
    if (secret && decodedHeader && safeEqual(decodedHeader, secret)) return true;

    const wallet = req.headers['x-wallet-address'];
    const challenge = req.headers['x-wallet-challenge'];
    const signature = req.headers['x-wallet-signature'];
    if (!wallet || !challenge || !signature || !walletSalt) return false;

    const expected = crypto.createHmac('sha256', walletSalt).update(`${wallet}:${challenge}`).digest('hex');
    return safeEqual(signature, expected);
  }

  function getPendingDecisions() {
    return typeof simulator.getPendingDecisions === 'function' ? simulator.getPendingDecisions() : [];
  }

  function getDecisionHistory() {
    return typeof simulator.getDecisionHistory === 'function' ? simulator.getDecisionHistory() : [];
  }

  function getActiveWatchlist() {
    return typeof simulator.getActiveWatchlist === 'function' ? simulator.getActiveWatchlist() : [];
  }

  const server = http.createServer((req, res) => {
    void (async () => {
    cors(res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Public: serve the web dashboard UI
    if (req.url === '/' || req.url === '/index.html') {
      const htmlPath = path.join(__dirname, 'index.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (_) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dashboard UI unavailable' }));
      }
      return;
    }

    if (!auth(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: use wallet signature or secret key' }));
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/dashboard') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        bankrollSol: simulator.state.bankrollSol,
        realizedPnlSol: simulator.state.realizedPnlSol,
        openPositions: simulator.state.openPositions,
        pendingDecisions: getPendingDecisions(),
        activeWatchlist: getActiveWatchlist(),
        strategyHealth: {
          dailyLossPct: simulator.state.dailyLossPct,
          drawdownPct: simulator.state.drawdownPct,
          circuitBreaker: simulator.state.circuitBreaker
        },
        recentLogs: logger.all().slice(-25)
      }));
      return;
    }

    if (req.url === '/agents') {
      const goalStatus = goalAgent ? goalAgent.summary(simulator.state) : null;
      const variantSummary = variantAgent ? variantAgent.getSummary() : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ goalStatus, variantSummary }));
      return;
    }

    // Combined summary endpoint — used by the web and mobile dashboards
    if (req.url === '/summary') {
      const goalStatus = goalAgent ? goalAgent.summary(simulator.state) : null;
      const variantSummary = variantAgent ? variantAgent.getSummary() : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        bankrollSol: simulator.state.bankrollSol,
        realizedPnlSol: simulator.state.realizedPnlSol,
        openPositions: simulator.state.openPositions,
        pendingDecisions: getPendingDecisions(),
        activeWatchlist: getActiveWatchlist(),
        strategyHealth: {
          dailyLossPct: simulator.state.dailyLossPct,
          drawdownPct: simulator.state.drawdownPct,
          circuitBreaker: simulator.state.circuitBreaker
        },
        recentLogs: logger.all().slice(-25),
        goalStatus,
        variantSummary
      }));
      return;
    }

    if (req.url === '/pending-decisions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        pendingDecisions: getPendingDecisions(),
        decisionHistory: getDecisionHistory().slice(0, 25)
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/decisions/approve') {
      if (typeof simulator.approvePendingDecision !== 'function') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Trade supervision unavailable' }));
        return;
      }
      const body = await readJsonBody(req);
      if (!body.id || typeof body.id !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Decision id is required' }));
        return;
      }
      try {
        const execution = await simulator.approvePendingDecision(body.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ approved: true, execution }));
      } catch (error) {
        res.writeHead(/not found|no longer has an open position/i.test(error.message) ? 404 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/decisions/reject') {
      if (typeof simulator.rejectPendingDecision !== 'function') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Trade supervision unavailable' }));
        return;
      }
      const body = await readJsonBody(req);
      if (!body.id || typeof body.id !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Decision id is required' }));
        return;
      }
      try {
        const rejected = simulator.rejectPendingDecision(body.id, body.reason);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rejected: true, decision: rejected }));
      } catch (error) {
        res.writeHead(/not found/i.test(error.message) ? 404 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    })().catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });

  return server;
}

module.exports = { createDashboardServer };
