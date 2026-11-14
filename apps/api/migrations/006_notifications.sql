-- قنوات العائلة: من لا واتساب له تصله رسالة نصية، ومن لا يقرأ تصله مكالمة.
alter table families add column has_whatsapp boolean not null default true;
alter table families add column prefers_voice boolean not null default false;

create type message_channel as enum ('WHATSAPP', 'SMS', 'VOICE');
create type notification_status as enum ('PENDING_APPROVAL', 'SENT', 'REJECTED');
create type message_status as enum ('SENT', 'DELIVERED', 'READ', 'FAILED', 'NO_PHONE');
create type notification_kind as enum ('MANUAL', 'CAMPAIGN_INVITE', 'DELIVERY_CONFIRMATION');

-- ---------- الإرسال الجماعي ----------
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  kind          notification_kind not null default 'MANUAL',
  title         text not null,
  body          text not null,
  audience      jsonb not null default '{}',
  campaign_id   uuid references campaigns(id),
  status        notification_status not null,
  recipients    integer not null default 0,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  constraint notification_decided_by_other check (decided_by is null or created_by is null or decided_by <> created_by)
);

-- ---------- رسالة لكل عائلة ----------
create table messages (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id),
  family_id       uuid not null references families(id),
  phone           text,
  channel         message_channel,
  text            text not null,
  status          message_status not null,
  tried           message_channel[] not null default '{}',
  error           text,
  provider_ref    text,
  sent_at         timestamptz not null default now()
);
create index messages_notification on messages(notification_id);
create index messages_family on messages(family_id, sent_at desc);

insert into settings (key, value) values ('bulk_message_approval_threshold', '500');
