-- ============================================================
-- LOGA Stock Scanner — movements log
-- One row per check-in / check-out event so the Dashboard can show
-- per-day totals, per-product history, and an audit log.
--
-- Safe to re-run (uses IF NOT EXISTS / DROP POLICY IF EXISTS).
-- Run this once in: Supabase → SQL Editor → New query → Run.
-- ============================================================

create table if not exists public.movements (
  id     uuid primary key default gen_random_uuid(),
  code   text references public.products(code) on delete cascade,
  serial text,                              -- null for quantity items
  kind   text not null check (kind in ('in','out')),
  qty    int  not null default 1,           -- typically 1 per scan
  shelf  text,
  at     timestamptz not null default now()
);

create index if not exists movements_at_idx      on public.movements (at desc);
create index if not exists movements_code_at_idx on public.movements (code, at desc);

alter table public.movements enable row level security;

drop policy if exists movements_anon_all on public.movements;
create policy movements_anon_all on public.movements
  for all to anon using (true) with check (true);

-- Realtime broadcast so all devices see new movements instantly.
-- (If the publication already includes it, this errors with "already member" — ignore.)
do $$ begin
  alter publication supabase_realtime add table public.movements;
exception when duplicate_object then null;
end $$;
