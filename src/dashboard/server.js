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

function createDashboardServer({ simulator, logger, goalAgent, variantAgent }) {
  const secret = process.env.DASHBOARD_SECRET_KEY;
  const walletSalt = process.env.WALLET_AUTH_SALT;

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'x-secret-key, x-wallet-address, x-wallet-challenge, x-wallet-signature, content-type'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }

  function auth(req) {
    const secretHeader = req.headers['x-secret-key'];
    if (secret && secretHeader && safeEqual(secretHeader, secret)) return true;

    const wallet = req.headers['x-wallet-address'];
    const challenge = req.headers['x-wallet-challenge'];
    const signature = req.headers['x-wallet-signature'];
    if (!wallet || !challenge || !signature || !walletSalt) return false;

    const expected = crypto.createHmac('sha256', walletSalt).update(`${wallet}:${challenge}`).digest('hex');
    return safeEqual(signature, expected);
  }

  const server = http.createServer((req, res) => {
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

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}

module.exports = { createDashboardServer };
