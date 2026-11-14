-- أجهزة الميدان: كل هاتف يُنصَّب عليه التطبيق يُسجَّل باسم موظفه، ويُسحب إن ضاع.
create table devices (
  id            uuid primary key,
  user_id       uuid not null references users(id),
  label         text not null,
  registered_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid references users(id),
  revoke_note   text,
  constraint revoked_complete check ((revoked_at is null) = (revoked_by is null))
);
create index devices_user on devices(user_id);
