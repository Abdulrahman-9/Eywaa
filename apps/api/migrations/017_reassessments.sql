-- إعادة التقييم عند الطلب: تُفتح بطلب من العائلة أو من الإدارة، تمرّ بزيارة، ثم يعتمدها غير من زار.
create type reassessment_source as enum ('FAMILY', 'STAFF');
create type reassessment_status as enum ('OPEN', 'VISITED', 'CLOSED', 'CANCELLED');
create type reassessment_outcome as enum ('NO_CHANGE', 'CHANGED');

create table reassessments (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references families(id),
  source       reassessment_source not null,
  reason       text not null,
  status       reassessment_status not null default 'OPEN',
  assigned_to  uuid references users(id),
  opened_by    uuid not null references users(id),
  opened_at    timestamptz not null default now(),
  visited_by   uuid references users(id),
  visited_at   timestamptz,
  findings     text,
  outcome      reassessment_outcome,
  client_op_id uuid unique,
  closed_by    uuid references users(id),
  closed_at    timestamptz,
  close_note   text,
  constraint visited_complete check ((status in ('VISITED', 'CLOSED')) = (visited_by is not null and visited_at is not null and findings is not null and outcome is not null) or status = 'CANCELLED'),
  -- من زار لا يعتمد زيارته.
  constraint closed_by_other check (status <> 'CLOSED' or (closed_by is not null and closed_by <> visited_by))
);
-- للعائلة طلب قائم واحد.
create unique index reassessments_one_open on reassessments(family_id) where status in ('OPEN', 'VISITED');
create index reassessments_assigned on reassessments(assigned_to) where status = 'OPEN';
