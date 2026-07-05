const fs = require('node:fs/promises');
const path = require('node:path');

async function loadState(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveState(filePath, snapshot) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    ...snapshot
  });
  await fs.writeFile(filePath, payload, 'utf8');
}

module.exports = { loadState, saveState };
