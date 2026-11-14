-- ---------- الصناديق ----------
-- المال المقيَّد ببرنامج يبقى في صندوقه حتى يُصرف في ذلك البرنامج.
create table funds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  program_id uuid references programs(id),
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into funds (name, note) values ('الصندوق العام', 'غير مقيَّد');

-- الحملة المالية تُصرف من صندوق بعينه.
alter table campaigns add column fund_id uuid references funds(id);

-- ---------- القيود ----------
create type entry_kind as enum (
  'RECEIPT', 'PAYMENT', 'CUSTODY_ISSUE', 'CUSTODY_RETURN', 'DISBURSEMENT', 'SHORTAGE', 'OVERAGE', 'REVERSAL'
);
create type entry_status as enum ('POSTED', 'PENDING', 'REJECTED');

create sequence receipt_no_seq;
create sequence payment_no_seq;
create sequence journal_no_seq;

create table ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  no             text not null unique,
  kind           entry_kind not null,
  status         entry_status not null,
  fund_id        uuid not null references funds(id),
  amount         bigint not null check (amount > 0),
  description    text not null,
  party          text,
  category       text,
  custody_user   uuid references users(id),
  entitlement_id uuid unique references entitlements(id),
  reverses       uuid unique references ledger_entries(id),
  created_by     uuid not null references users(id),
  created_at     timestamptz not null default now(),
  decided_by     uuid references users(id),
  decided_at     timestamptz,
  decision_note  text,
  constraint entry_decided_by_other check (decided_by is null or decided_by <> created_by)
);
create index ledger_entries_fund on ledger_entries(fund_id, created_at desc);

-- لكل قيد سطران: مدين ودائن بالمبلغ نفسه. لا يُحذف قيد؛ يُعكس بقيد مقابل.
create table ledger_lines (
  entry_id uuid not null references ledger_entries(id),
  account  text not null,
  debit    bigint not null default 0 check (debit >= 0),
  credit   bigint not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0))
);
create index ledger_lines_entry on ledger_lines(entry_id);
create index ledger_lines_account on ledger_lines(account);

create function ledger_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'ledger lines are append-only';
end $$;
create trigger ledger_lines_no_change before update or delete on ledger_lines
  for each row execute function ledger_immutable();
