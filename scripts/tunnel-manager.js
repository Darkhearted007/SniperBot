#!/usr/bin/env node
/**
 * Hybrid tunnel manager for extreme/home-server testing.
 *
 * Runs BOTH an ngrok tunnel and a Cloudflare quick tunnel pointed at the
 * same local port, so the SniperBot dashboard/API stays reachable even if
 * one provider has an outage, drops the connection, or rate-limits you.
 * Neither tunnel is authoritative — the dashboard (src/dashboard/index.html)
 * is what actually does the failover, by trying the primary URL first on
 * every poll and falling back to the secondary URL if that fails. This
 * script's job is just: keep both tunnels alive, and tell you their
 * current public URLs.
 *
 * Requirements on PATH: `ngrok` (with an authtoken already configured via
 * `ngrok config add-authtoken <token>`) and `cloudflared`.
 *
 * Usage: node scripts/tunnel-manager.js [--port 3000]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { parseCloudflaredLogLine, parseNgrokTunnelsResponse } = require('./tunnelParsers');

const STATUS_FILE = path.join(__dirname, '..', 'tunnel-status.json');
const NGROK_API_POLL_INTERVAL_MS = 2_000;
const NGROK_API_MAX_ATTEMPTS = 30;
const BASE_RESPAWN_DELAY_MS = 3_000;
const MAX_RESPAWN_DELAY_MS = 60_000;

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT) || 3000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      args.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function writeStatus(status) {
  const withTimestamp = { ...status, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(withTimestamp, null, 2));
}

function log(label, message) {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
}

/**
 * Fetches ngrok's local API to discover the public URL it assigned. Retries
 * for a while since ngrok needs a moment to establish the tunnel after the
 * process starts.
 */
async function pollNgrokUrl() {
  for (let attempt = 0; attempt < NGROK_API_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (response.ok) {
        const body = await response.text();
        const url = parseNgrokTunnelsResponse(body);
        if (url) return url;
      }
    } catch (error) {
      // ngrok's local API isn't up yet; keep retrying until max attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, NGROK_API_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Spawns a tunnel process and keeps it running, respawning with
 * exponential backoff if it exits unexpectedly. Calls onSpawn whenever a
 * fresh process starts (which can happen more than once, since a respawn
 * gets a brand-new random URL on the free tiers of both providers).
 */
function superviseProcess({ label, command, args, onSpawn, onLine, onExit }) {
  let respawnDelayMs = BASE_RESPAWN_DELAY_MS;
  let stopped = false;

  function spawnOnce() {
    if (stopped) return;
    log(label, `starting: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });
    stdoutReader.on('line', (line) => onLine?.(line));
    stderrReader.on('line', (line) => onLine?.(line));

    child.on('error', (error) => {
      log(label, `failed to start (${error.message}). Is "${command}" installed and on PATH?`);
    });

    child.on('exit', (code, signal) => {
      log(label, `exited (code=${code}, signal=${signal})`);
      onExit?.();
      if (stopped) return;
      log(label, `respawning in ${respawnDelayMs}ms`);
      setTimeout(spawnOnce, respawnDelayMs);
      respawnDelayMs = Math.min(respawnDelayMs * 2, MAX_RESPAWN_DELAY_MS);
    });

    onSpawn?.(child);
    // Reset backoff once the process has stayed up a reasonable while.
    setTimeout(() => { respawnDelayMs = BASE_RESPAWN_DELAY_MS; }, 30_000);
    return child;
  }

  spawnOnce();
  return { stop: () => { stopped = true; } };
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));
  const status = {
    port,
    primary: { provider: 'ngrok', url: null, healthy: false },
    secondary: { provider: 'cloudflare', url: null, healthy: false }
  };
  writeStatus(status);

  log('manager', `watching local port ${port}; writing status to ${STATUS_FILE}`);

  superviseProcess({
    label: 'ngrok',
    command: 'ngrok',
    args: ['http', String(port), '--log=stdout'],
    onLine: (line) => log('ngrok', line),
    onSpawn: async () => {
      status.primary.healthy = false;
      writeStatus(status);
      const url = await pollNgrokUrl();
      status.primary.url = url;
      status.primary.healthy = Boolean(url);
      writeStatus(status);
      if (url) {
        log('ngrok', `public URL: ${url}  <-- set this as "Server URL" in the dashboard`);
      } else {
        log('ngrok', 'could not detect a public URL after polling the local API');
      }
    },
    onExit: () => {
      status.primary.healthy = false;
      writeStatus(status);
    }
  });

  superviseProcess({
    label: 'cloudflared',
    command: 'cloudflared',
    args: ['tunnel', '--url', `http://localhost:${port}`],
    onLine: (line) => {
      log('cloudflared', line);
      const url = parseCloudflaredLogLine(line);
      if (url && url !== status.secondary.url) {
        status.secondary.url = url;
        status.secondary.healthy = true;
        writeStatus(status);
        log('cloudflared', `public URL: ${url}  <-- set this as "Fallback Server URL" in the dashboard`);
      }
    },
    onExit: () => {
      status.secondary.healthy = false;
      writeStatus(status);
    }
  });
}

main().catch((error) => {
  console.error('Fatal tunnel-manager error:', error);
  process.exitCode = 1;
});
