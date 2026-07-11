/**
 * Supabase client for SniperBot persistence layer.
 *
 * Provides trade history, bot state, approval queue, and decision logging
 * backed by a Postgres database.
 *
 * Required environment variables:
 *   SUPABASE_URL        – Project URL from https://supabase.com/dashboard/project/_/settings/api
 *   SUPABASE_ANON_KEY   – Anon / public key (safe for client-side use)
 *   SUPABASE_SERVICE_ROLE_KEY – Service role key (server-side only, full access)
 */
const { createClient } = require('@supabase/supabase-js');

function createSupabaseClient(env = process.env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  const client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return client;
}

/**
 * Attempt to create the required tables if they don't exist.
 * Safe to call on every boot — uses IF NOT EXISTS.
 */
async function ensureTables(supabase) {
  // We use raw SQL via the Supabase management API (rpc) or REST.
  // The cleanest approach for self-hosted is to run the SQL migration
  // separately, but we also attempt auto-creation here using the
  // pg_enable_extension and raw query endpoints.
  const sql = `
    CREATE TABLE IF NOT EXISTS public.bot_state (
      id          TEXT PRIMARY KEY DEFAULT 'default',
      mode        TEXT NOT NULL DEFAULT 'paper',
      snapshot    JSONB NOT NULL DEFAULT '{}',
      version     INTEGER NOT NULL DEFAULT 1,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.trade_decisions (
      id            BIGSERIAL PRIMARY KEY,
      opportunity   JSONB,
      safety        JSONB,
      decision      JSONB,
      state         JSONB,
      position      JSONB,
      exit_decision JSONB,
      supervision   JSONB,
      type          TEXT NOT NULL DEFAULT 'decision',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.trade_executions (
      id            BIGSERIAL PRIMARY KEY,
      kind          TEXT NOT NULL,
      opportunity   JSONB,
      position      JSONB,
      execution     JSONB,
      decision      JSONB,
      exit_decision JSONB,
      supervision   JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.trade_approvals (
      id            TEXT PRIMARY KEY,
      key           TEXT NOT NULL,
      kind          TEXT NOT NULL,
      opportunity   JSONB,
      decision      JSONB,
      position      JSONB,
      exit_decision JSONB,
      status        TEXT NOT NULL DEFAULT 'pending',
      reason        TEXT,
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at   TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_trade_decisions_created_at
      ON public.trade_decisions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trade_executions_created_at
      ON public.trade_executions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trade_approvals_status
      ON public.trade_approvals (status);
  `;

  try {
    const { error } = await supabase.rpc('exec_sql', { sql });
    if (error) {
      // rpc may not be available; that's okay — tables can be created manually
      console.warn('[supabase] Could not auto-create tables via RPC:', error.message);
      console.warn('[supabase] Please run the SQL migration manually (see supabase-migration.sql)');
    }
  } catch (err) {
    console.warn('[supabase] Auto-migration failed:', err.message);
  }
}

module.exports = { createSupabaseClient, ensureTables };
