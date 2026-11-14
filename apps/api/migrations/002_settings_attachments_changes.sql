-- ---------- الإعدادات ----------
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table settings_history (
  id         bigserial primary key,
  key        text not null,
  old_value  jsonb,
  new_value  jsonb not null,
  changed_by uuid not null references users(id),
  changed_at timestamptz not null default now()
);

-- خط الفقر: دخل الفرد الشهري بالدينار العراقي.
insert into settings (key, value) values ('poverty_line_iqd', '300000');

-- ---------- المرفقات ----------
create type attachment_category as enum (
  'PHOTO', 'IDENTITY', 'RATION_CARD', 'RESIDENCE_CARD', 'MEDICAL', 'PAPER_FORM', 'OTHER'
);

create table attachments (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references families(id),
  person_id     uuid references persons(id),
  category      attachment_category not null,
  original_name text not null,
  mime          text not null,
  size_bytes    integer not null,
  sha256        text not null,
  storage_key   text not null unique,
  uploaded_by   uuid not null references users(id),
  created_at    timestamptz not null default now(),
  deleted_by    uuid references users(id),
  deleted_at    timestamptz
);
create index attachments_family on attachments(family_id) where deleted_at is null;

-- ---------- طلبات التعديل ----------
create type change_type as enum (
  'UPDATE_FAMILY', 'SET_INCOMES', 'SET_PROXIES', 'ADD_MEMBER', 'UPDATE_MEMBER', 'ADD_DOCUMENT'
);
create type change_status as enum ('PENDING', 'APPROVED', 'REJECTED');

create table change_requests (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references families(id),
  type          change_type not null,
  payload       jsonb not null,
  reason        text not null,
  status        change_status not null default 'PENDING',
  requested_by  uuid not null references users(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  constraint change_decided_by_other check (decided_by is null or decided_by <> requested_by)
);
create index change_requests_family on change_requests(family_id);
create index change_requests_pending on change_requests(requested_at) where status = 'PENDING';
