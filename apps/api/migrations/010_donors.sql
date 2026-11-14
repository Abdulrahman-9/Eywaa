-- ---------- المتبرعون ----------
create table donors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  phone      text,
  note       text,
  created_at timestamptz not null default now()
);

-- التبرع النقدي سند قبض، والعيني وارد مخزن؛ وكلاهما يُنسب إلى متبرعه.
alter table ledger_entries add column donor_id uuid references donors(id);
alter table stock_moves add column donor_id uuid references donors(id);
create index ledger_entries_donor on ledger_entries(donor_id);
create index stock_moves_donor on stock_moves(donor_id);
