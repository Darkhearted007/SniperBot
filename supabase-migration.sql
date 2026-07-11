-- SniperBot Supabase Migration
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql/new)
-- or via the Supabase CLI.

-- ── Bot State ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_state (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  mode        TEXT NOT NULL DEFAULT 'paper',
  snapshot    JSONB NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Trade Decisions ─────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_trade_decisions_created_at
  ON public.trade_decisions (created_at DESC);

-- ── Trade Executions ────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_trade_executions_created_at
  ON public.trade_executions (created_at DESC);

-- ── Trade Approvals (supervision queue) ─────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_trade_approvals_status
  ON public.trade_approvals (status);

-- Enable Row-Level Security (optional — recommended for multi-user setups)
ALTER TABLE public.bot_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_approvals ENABLE ROW LEVEL SECURITY;

-- Allow all operations for the service role / anon key (adjust as needed)
CREATE POLICY "Allow all" ON public.bot_state USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.trade_decisions USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.trade_executions USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON public.trade_approvals USING (true) WITH CHECK (true);
