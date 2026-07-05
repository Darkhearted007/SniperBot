const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function safeEqual(a, b) {
  const aBuf = Buffer.from(a || '');
  const bBuf = Buffer.from(b || '');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function decodeBase58(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Wallet address is required');
  }

  const bytes = [0];
  for (const char of value.trim()) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Wallet address must be base58-encoded');
    }

    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return Buffer.from(bytes.reverse());
}

function createPublicKeyFromWalletAddress(walletAddress) {
  const publicKeyBytes = decodeBase58(walletAddress);
  if (publicKeyBytes.length !== 32) {
    throw new Error('Wallet address must decode to 32 bytes');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: 'der',
    type: 'spki'
  });
}

function verifyWalletSignature({ walletAddress, message, signature }) {
  try {
    const publicKey = createPublicKeyFromWalletAddress(walletAddress);
    const signatureBytes = Buffer.from(String(signature || ''), 'base64');
    if (signatureBytes.length === 0) {
      return false;
    }
    return crypto.verify(null, Buffer.from(String(message || ''), 'utf8'), publicKey, signatureBytes);
  } catch (_) {
    return false;
  }
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
  const allowedWallets = new Set(
    String(process.env.DASHBOARD_ALLOWED_WALLETS || '')
      .split(',')
      .map((wallet) => wallet.trim())
      .filter(Boolean)
  );
  const challengeTtlMs = Number(process.env.DASHBOARD_CHALLENGE_TTL_MS || 5 * 60 * 1000);
  const sessionTtlMs = Number(process.env.DASHBOARD_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
  const authChallenges = new Map();
  const authSessions = new Map();

  function walletAuthEnabled() {
    return allowedWallets.size > 0;
  }

  function pruneExpiredEntries() {
    const now = Date.now();
    for (const [challengeId, challenge] of authChallenges.entries()) {
      if (challenge.expiresAtMs <= now) authChallenges.delete(challengeId);
    }
    for (const [token, session] of authSessions.entries()) {
      if (session.expiresAtMs <= now) authSessions.delete(token);
    }
  }

  function issueWalletChallenge(walletAddress, host) {
    if (!walletAuthEnabled()) {
      throw new Error('Wallet auth unavailable: set DASHBOARD_ALLOWED_WALLETS');
    }
    if (!allowedWallets.has(walletAddress)) {
      throw new Error('Wallet is not authorized for dashboard access');
    }

    pruneExpiredEntries();
    createPublicKeyFromWalletAddress(walletAddress);

    const challengeId = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const issuedAt = new Date().toISOString();
    const expiresAtMs = Date.now() + challengeTtlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const message = [
      'Sign in to SniperBot dashboard',
      `Wallet: ${walletAddress}`,
      `Server: ${host || 'unknown-host'}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
      `Expires At: ${expiresAt}`
    ].join('\n');

    authChallenges.set(challengeId, {
      walletAddress,
      message,
      expiresAtMs
    });

    return {
      challengeId,
      message,
      expiresAt
    };
  }

  function issueSession(walletAddress) {
    pruneExpiredEntries();

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = Date.now() + sessionTtlMs;
    authSessions.set(token, { walletAddress, expiresAtMs });

    return {
      token,
      walletAddress,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, x-secret-key, content-type'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  function getSessionToken(req) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return undefined;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : undefined;
  }

  function auth(req) {
    pruneExpiredEntries();

    const sessionToken = getSessionToken(req);
    if (sessionToken) {
      const session = authSessions.get(sessionToken);
      if (session && session.expiresAtMs > Date.now()) return true;
      authSessions.delete(sessionToken);
    }

    const secretHeader = req.headers['x-secret-key'];
    let decodedHeader;
    try { decodedHeader = secretHeader ? decodeURIComponent(secretHeader) : secretHeader; }
    catch (_) { decodedHeader = secretHeader; } // malformed percent-encoding: compare as-is (will fail auth)
    if (secret && decodedHeader && safeEqual(decodedHeader, secret)) return true;
    return false;
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

  // Periodically prune expired auth entries even when the dashboard is idle
  const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const pruneTimer = setInterval(pruneExpiredEntries, PRUNE_INTERVAL_MS);
  pruneTimer.unref(); // Don't prevent the process from exiting naturally

  const server = http.createServer((req, res) => {
    void (async () => {
    cors(res);
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Public: serve the web dashboard UI
    if (pathname === '/' || pathname === '/index.html') {
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

    if (req.method === 'GET' && pathname === '/auth/challenge') {
      const walletAddress = String(requestUrl.searchParams.get('wallet') || '').trim();
      if (!walletAddress) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wallet address is required' }));
        return;
      }
      try {
        const challenge = issueWalletChallenge(walletAddress, req.headers.host);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(challenge));
      } catch (error) {
        const status = /not authorized/i.test(error.message) ? 403 : /unavailable/i.test(error.message) ? 503 : 400;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/verify') {
      const body = await readJsonBody(req);
      const challengeId = String(body.challengeId || '').trim();
      const walletAddress = String(body.walletAddress || body.wallet || '').trim();
      const signature = String(body.signature || '').trim();

      if (!challengeId || !walletAddress || !signature) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'challengeId, walletAddress, and signature are required' }));
        return;
      }
      if (!walletAuthEnabled()) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wallet auth unavailable: set DASHBOARD_ALLOWED_WALLETS' }));
        return;
      }
      if (!allowedWallets.has(walletAddress)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wallet is not authorized for dashboard access' }));
        return;
      }

      const challenge = authChallenges.get(challengeId);
      if (!challenge || challenge.expiresAtMs <= Date.now()) {
        authChallenges.delete(challengeId);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Challenge is missing or expired' }));
        return;
      }
      if (challenge.walletAddress !== walletAddress) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Challenge wallet does not match request wallet' }));
        return;
      }
      if (!verifyWalletSignature({ walletAddress, message: challenge.message, signature })) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wallet signature verification failed' }));
        return;
      }

      authChallenges.delete(challengeId);
      const session = issueSession(walletAddress);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
      const sessionToken = getSessionToken(req);
      if (sessionToken) authSessions.delete(sessionToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ loggedOut: true }));
      return;
    }

    if (!auth(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: use a wallet session or secret key' }));
      return;
    }

    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (pathname === '/dashboard') {
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

    if (pathname === '/agents') {
      const goalStatus = goalAgent ? goalAgent.summary(simulator.state) : null;
      const variantSummary = variantAgent ? variantAgent.getSummary() : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ goalStatus, variantSummary }));
      return;
    }

    // Combined summary endpoint — used by the web and mobile dashboards
    if (pathname === '/summary') {
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

    if (pathname === '/pending-decisions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        pendingDecisions: getPendingDecisions(),
        decisionHistory: getDecisionHistory().slice(0, 25)
      }));
      return;
    }

    if (req.method === 'POST' && pathname === '/decisions/approve') {
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

    if (req.method === 'POST' && pathname === '/decisions/reject') {
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

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(pruneTimer);
    return originalClose(callback);
  };

  return server;
}

module.exports = { createDashboardServer };
