-- ---------- المتعهدون ----------
create table contractors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  phone      text,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- مشاريع بناء المنازل ----------
create type housing_status as enum ('PENDING_APPROVAL', 'ACTIVE', 'DELIVERED', 'CANCELLED', 'REJECTED');

create table housing_projects (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references families(id),
  contractor_id uuid not null references contractors(id),
  fund_id       uuid not null references funds(id),
  location      text not null,
  budget        bigint not null check (budget > 0),
  contract_date date not null,
  duration_days integer not null check (duration_days > 0),
  status        housing_status not null default 'PENDING_APPROVAL',
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  constraint housing_decided_by_other check (decided_by is null or decided_by <> created_by)
);
-- للعائلة مشروع قائم واحد.
create unique index one_open_house_per_family on housing_projects(family_id) where status in ('PENDING_APPROVAL', 'ACTIVE');

-- ---------- المراحل ----------
-- PLANNED: لم تُطلب · CLAIMED: طلب المتعهد صرفها · VERIFIED: زارها المشرف وتحقق · PAID: اعتُمدت وصُرفت دفعتها
create type stage_status as enum ('PLANNED', 'CLAIMED', 'VERIFIED', 'PAID');

create table housing_stages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references housing_projects(id),
  seq         integer not null,
  name        text not null,
  amount      bigint not null check (amount > 0),
  status      stage_status not null default 'PLANNED',
  claimed_at  timestamptz,
  claim_note  text,
  verified_by uuid references users(id),
  verified_at timestamptz,
  verify_note text,
  approved_by uuid references users(id),
  approved_at timestamptz,
  payment_entry uuid unique references ledger_entries(id),
  unique (project_id, seq),
  -- لا تُصرف دفعة مرحلة لم يتحقق منها موظف ويعتمدها آخر.
  constraint paid_needs_two check (
    status <> 'PAID' or (verified_by is not null and approved_by is not null and approved_by <> verified_by and payment_entry is not null)
  )
);

alter table attachments add column stage_id uuid references housing_stages(id);
alter type attachment_category add value 'HOUSING_PROGRESS';
