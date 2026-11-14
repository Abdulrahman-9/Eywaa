-- ---------- نقاط التوزيع ----------
create table distribution_points (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- الحملات ----------
create type campaign_status as enum ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'CLOSED', 'CANCELLED', 'REJECTED');

create table campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  program_id    uuid not null references programs(id),
  unit          text not null,
  starts_on     date not null,
  ends_on       date not null check (ends_on >= starts_on),
  status        campaign_status not null default 'DRAFT',
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  closed_by     uuid references users(id),
  closed_at     timestamptz,
  constraint campaign_decided_by_other check (decided_by is null or decided_by <> created_by)
);

-- ---------- استحقاق كل عائلة في الحملة ----------
create type entitlement_status as enum ('PENDING', 'DELIVERED', 'CANCELLED');
create type receiver_kind as enum ('HEAD', 'PROXY');
create type delivery_mode as enum ('ONLINE', 'OFFLINE');

create table entitlements (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references campaigns(id),
  family_id        uuid not null references families(id),
  point_id         uuid not null references distribution_points(id),
  serial           integer not null,
  quantity         integer not null check (quantity > 0),
  code_hash        text,
  code_enc         text,
  status           entitlement_status not null default 'PENDING',
  delivered_at     timestamptz,
  delivered_by     uuid references users(id),
  delivered_point  uuid references distribution_points(id),
  device_id        text,
  mode             delivery_mode,
  receiver         receiver_kind,
  receiver_name    text,
  proof_attachment uuid references attachments(id),
  client_op_id     uuid unique,
  unique (campaign_id, family_id),
  unique (campaign_id, serial),
  -- المسلَّم يحمل وقته وصاحبه ومستلمه؛ وغير المسلَّم لا يحمل شيئاً منها.
  constraint delivered_complete check (
    (status = 'DELIVERED') = (delivered_at is not null and delivered_by is not null and receiver is not null)
  )
);
create index entitlements_family on entitlements(family_id);
create index entitlements_point on entitlements(campaign_id, point_id);

-- ---------- ما رُفض من محاولات التسليم، وما كُشف عند المزامنة ----------
create type incident_kind as enum (
  'ALREADY_DELIVERED', 'BAD_SIGNATURE', 'EXPIRED', 'NOT_ACTIVE', 'CANCELLED', 'WRONG_POINT_OFFLINE', 'DOUBLE_DELIVERY', 'BAD_CODE'
);

create table delivery_incidents (
  id             uuid primary key default gen_random_uuid(),
  kind           incident_kind not null,
  entitlement_id uuid references entitlements(id),
  campaign_id    uuid references campaigns(id),
  point_id       uuid references distribution_points(id),
  device_id      text,
  reported_by    uuid not null references users(id),
  at             timestamptz not null default now(),
  details        jsonb not null default '{}'
);
create index delivery_incidents_campaign on delivery_incidents(campaign_id, at desc);

alter type attachment_category add value 'DELIVERY_PROOF';
