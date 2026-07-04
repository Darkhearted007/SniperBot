const http = require('node:http');
const crypto = require('node:crypto');

function safeEqual(a, b) {
  const aBuf = Buffer.from(a || '');
  const bBuf = Buffer.from(b || '');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function createDashboardServer({ simulator, logger, goalAgent, variantAgent }) {
  const secret = process.env.DASHBOARD_SECRET_KEY;
  const walletSalt = process.env.WALLET_AUTH_SALT;

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

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}

module.exports = { createDashboardServer };
