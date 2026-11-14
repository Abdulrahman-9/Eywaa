-- الصرف بالحوالة والمحفظة الإلكترونية: كشف دفع يُنشئه موظف ويعتمده آخر بعد تنفيذه.
alter type delivery_mode add value if not exists 'TRANSFER';

create type payout_method as enum ('TRANSFER', 'WALLET');
create type payout_status as enum ('PENDING_APPROVAL', 'PAID', 'REJECTED');
create sequence payout_no_seq;

create table payout_batches (
  id            uuid primary key default gen_random_uuid(),
  no            integer not null default nextval('payout_no_seq') unique,
  campaign_id   uuid not null references campaigns(id),
  method        payout_method not null,
  provider      text not null,
  status        payout_status not null default 'PENDING_APPROVAL',
  total         bigint not null check (total > 0),
  items         integer not null check (items > 0),
  paid_total    bigint,
  paid_items    integer,
  reference     text,
  note          text,
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  entry_id      uuid references ledger_entries(id),
  -- من أنشأ الكشف لا يعتمده، والمدفوع يحمل مرجع تنفيذه.
  constraint payout_two_people check (status <> 'PAID' or (decided_by is not null and decided_by <> created_by)),
  constraint payout_paid_has_reference check (status <> 'PAID' or reference is not null)
);
create index payout_batches_campaign on payout_batches(campaign_id);

create table payout_items (
  batch_id       uuid not null references payout_batches(id),
  entitlement_id uuid not null references entitlements(id),
  family_no      text not null,
  recipient      text not null,
  account        text not null,
  amount         integer not null check (amount > 0),
  -- null: ينتظر. true: دُفع. false: لم يُدفع، وسببه في skip_reason.
  paid           boolean,
  skip_reason    text,
  active         boolean not null default true,
  primary key (batch_id, entitlement_id)
);
-- الاستحقاق لا يدخل كشفين قائمين: لا يُدفع مرتين.
create unique index payout_items_one_open on payout_items(entitlement_id) where active;
