-- طلب التسجيل السريع: اسم رب الأسرة وما تيسّر معه، يُستكمل لاحقاً باستمارة كاملة تمرّ بكشف التكرار والاعتماد.
-- ليس عائلة: لا يدخل حملة ولا يأخذ نقاطاً حتى يُستكمل.
create type quick_source as enum ('STAFF', 'EMERGENCY');
create type quick_status as enum ('NEW', 'INVITED', 'VISIT_ASSIGNED', 'COMPLETED', 'DISMISSED');
create sequence quick_request_no_seq;

create table quick_requests (
  id            uuid primary key default gen_random_uuid(),
  no            integer not null default nextval('quick_request_no_seq') unique,
  head_name     text not null,
  name_norm     text not null,
  phone         text,
  mahalla       text,
  landmark      text,
  members_count integer check (members_count between 1 and 50),
  note          text,
  source        quick_source not null default 'STAFF',
  campaign_id   uuid references campaigns(id),
  status        quick_status not null default 'NEW',
  assigned_to   uuid references users(id),
  invited_at    timestamptz,
  family_id     uuid references families(id),
  client_op_id  uuid unique,
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  closed_by     uuid references users(id),
  closed_at     timestamptz,
  close_note    text,
  constraint completed_has_family check ((status = 'COMPLETED') = (family_id is not null))
);
create index quick_requests_open on quick_requests(created_at desc) where status in ('NEW', 'INVITED', 'VISIT_ASSIGNED');
create index quick_requests_name on quick_requests using gin (name_norm gin_trgm_ops);

-- رسالة إلى هاتف ليس لعائلة مسجَّلة بعد (دعوة صاحب طلب سريع للحضور).
alter table messages alter column family_id drop not null;
alter table messages add column quick_request_id uuid references quick_requests(id);
alter table messages add constraint message_has_target check (family_id is not null or quick_request_id is not null);
