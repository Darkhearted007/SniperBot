/**
 * Pure parsing helpers for the tunnel manager. Kept separate from the
 * process-spawning/orchestration logic in tunnel-manager.js so the parsing
 * rules (which are the part most likely to break when ngrok/cloudflared
 * change their output format) can be unit tested without spawning real
 * child processes or making real HTTP calls.
 */

/**
 * Extracts the public HTTPS URL from ngrok's local API response
 * (GET http://127.0.0.1:4040/api/tunnels). ngrok can report multiple
 * tunnels (e.g. an auto-created http + https pair); this prefers the
 * https one since that's what a browser dashboard should be pointed at.
 */
function parseNgrokTunnelsResponse(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (error) {
    return null;
  }
  const tunnels = parsed?.tunnels || [];
  const httpsTunnel = tunnels.find((t) => t.public_url?.startsWith('https://'));
  return httpsTunnel?.public_url || tunnels[0]?.public_url || null;
}

// cloudflared prints its quick-tunnel URL to stdout/stderr inside a
// decorative box, e.g.:
//   |  https://random-words-1234.trycloudflare.com                          |
const CLOUDFLARED_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Scans a single line of cloudflared's log output for its quick-tunnel URL.
 * Returns null if the line doesn't contain one.
 */
function parseCloudflaredLogLine(line) {
  const match = CLOUDFLARED_URL_PATTERN.exec(String(line || ''));
  return match ? match[0] : null;
}

module.exports = { parseNgrokTunnelsResponse, parseCloudflaredLogLine };
