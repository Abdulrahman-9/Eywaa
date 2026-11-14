-- ---------- البرامج وقواعد الاستحقاق ----------
create type program_kind as enum ('MONEY', 'IN_KIND', 'PROJECT', 'SERVICE');

create table programs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  kind         program_kind not null,
  unit         text not null,            -- وحدة المقدار: دينار، سلة، قطعة...
  rules        jsonb not null default '{}',
  amount       jsonb not null,
  min_gap_days integer not null default 0 check (min_gap_days >= 0),
  active       boolean not null default true,
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
