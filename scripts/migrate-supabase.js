#!/usr/bin/env node
/**
 * Supabase migration script for SniperBot.
 *
 * Run: node scripts/migrate-supabase.js
 *
 * Requires these environment variables (from start.sh):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const { createClient } = require('@supabase/supabase-js');

const MIGRATION_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_trade_decisions_created_at ON public.trade_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_executions_created_at ON public.trade_executions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_approvals_status ON public.trade_approvals (status);
`;

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in environment.');
    console.error('Run this from the project root where start.sh is sourced, or set them manually.');
    process.exit(1);
  }

  console.log(`Supabase URL: ${url}`);
  console.log('Connecting with service role key...');

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Method 1: Try exec_sql RPC with various parameter names
  const variants = [
    { name: 'exec_sql(sql)', rpc: 'exec_sql', params: { sql: MIGRATION_SQL } },
    { name: 'exec_sql(query_text)', rpc: 'exec_sql', params: { query_text: MIGRATION_SQL } },
    { name: 'exec_sql_single(sql)', rpc: 'exec_sql_single', params: { sql: MIGRATION_SQL } },
    { name: 'exec_sql_single(query_text)', rpc: 'exec_sql_single', params: { query_text: MIGRATION_SQL } },
    { name: 'pg_execute(query_text)', rpc: 'pg_execute', params: { query_text: MIGRATION_SQL } },
    { name: 'pg_execute_sql(query_text)', rpc: 'pg_execute_sql', params: { query_text: MIGRATION_SQL } },
  ];

  for (const variant of variants) {
    const { error } = await supabase.rpc(variant.rpc, variant.params);
    if (!error) {
      console.log(`✅ Migration succeeded via ${variant.name}!`);
      await verifyTables(supabase);
      return;
    }
    // Only show the first error as a sample
    if (variant === variants[0]) {
      console.log(`  ${variant.name}: ${error.message}`);
    }
  }

  // Method 2: Try creating a simple record to test connection
  console.log('\nTrying direct table access...');
  const { error: pingError } = await supabase.from('bot_state').select('id').limit(1);
  if (pingError && pingError.message.includes('not find the table')) {
    console.log('  Tables confirmed missing — need manual migration.');
  } else if (!pingError) {
    console.log('  ✅ bot_state table already exists!');
    return;
  }

  console.log('\n❌ Could not auto-create tables.');
  console.log('The exec_sql RPC is not available on your Supabase project.');
  console.log('');
  console.log('👉 Open this link in your browser:');
  console.log(`   https://supabase.com/dashboard/project/${new URL(url).hostname.split('.')[0]}/sql/new`);
  console.log('');
  console.log('👉 Paste this SQL in the editor and click "Run":');
  console.log('');
  console.log(MIGRATION_SQL.trim());
  console.log('');
  process.exit(1);
}

async function verifyTables(supabase) {
  const tables = ['bot_state', 'trade_decisions', 'trade_executions', 'trade_approvals'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    if (error) {
      console.log(`  ⚠️  ${table}: ${error.message}`);
    } else {
      console.log(`  ✅ ${table}: ready`);
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
