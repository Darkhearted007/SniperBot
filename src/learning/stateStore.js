const fs = require('node:fs/promises');
const path = require('node:path');
const { createSupabaseClient } = require('../lib/supabase');

/**
 * Load bot state — tries Supabase first, falls back to file-based JSON.
 */
async function loadState(filePath, env = process.env) {
  // Try Supabase first if configured
  const supabase = createSupabaseClient(env);
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('bot_state')
        .select('snapshot, mode, version, updated_at')
        .eq('id', 'default')
        .single();

      if (!error && data) {
        return {
          ...data.snapshot,
          _supabase_meta: { mode: data.mode, version: data.version, updatedAt: data.updated_at }
        };
      }
    } catch (_) {
      // Supabase unavailable — fall through to file
    }
  }

  // Fall back to file-based loading
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

/**
 * Save bot state — writes to Supabase AND file for redundancy.
 */
async function saveState(filePath, snapshot, env = process.env) {
  // Save to Supabase if configured
  const supabase = createSupabaseClient(env);
  if (supabase) {
    try {
      const payload = {
        id: 'default',
        mode: env.TRADING_MODE || 'paper',
        snapshot,
        version: 1,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('bot_state')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('[stateStore] Supabase save warning:', error.message);
      }
    } catch (err) {
      console.warn('[stateStore] Supabase save failed:', err.message);
    }
  }

  // Always save to file as well for redundancy
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
