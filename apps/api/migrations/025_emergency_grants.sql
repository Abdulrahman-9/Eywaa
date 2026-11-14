-- التخويل الاستثنائي: يأذن المدير لمتعهد بصرف وجبات لغير المسجَّلين في حملة، بسقف ومدة وسبب.
-- كل حالة توثَّق باسمها، وتصير طلب تسجيل سريع يُستكمل لاحقاً.
create type grant_status as enum ('ACTIVE', 'REVOKED');

create table emergency_grants (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(id),
  agent_id     uuid not null references users(id),
  point_id     uuid not null references distribution_points(id),
  max_cases    integer not null check (max_cases between 1 and 500),
  per_case     integer not null check (per_case > 0),
  expires_at   timestamptz not null,
  reason       text not null,
  status       grant_status not null default 'ACTIVE',
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  revoked_by   uuid references users(id),
  revoked_at   timestamptz,
  revoke_note  text,
  constraint grant_not_self check (created_by <> agent_id)
);
create index emergency_grants_campaign on emergency_grants(campaign_id);
create index emergency_grants_agent on emergency_grants(agent_id) where status = 'ACTIVE';

create table emergency_cases (
  id               uuid primary key default gen_random_uuid(),
  grant_id         uuid not null references emergency_grants(id),
  quick_request_id uuid not null references quick_requests(id),
  head_name        text not null,
  name_norm        text not null,
  phone            text,
  quantity         integer not null check (quantity > 0),
  delivered_at     timestamptz not null,
  -- ما لفت النظر عند التسجيل: اسم يشبه مسجَّلاً، أو صُرف له بتخويل من قبل. للمراجعة لا للمنع.
  warnings         text[] not null default '{}',
  client_op_id     uuid unique,
  created_by       uuid not null references users(id),
  created_at       timestamptz not null default now()
);
create index emergency_cases_grant on emergency_cases(grant_id);
create index emergency_cases_name on emergency_cases using gin (name_norm gin_trgm_ops);

-- خصم المخزون لحالة استثنائية لا يحمل استحقاقاً؛ يحمل الحالة.
alter table stock_moves add column emergency_case_id uuid unique references emergency_cases(id);
