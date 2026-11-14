-- طابور الإرسال: الرسالة تُكتب أولاً ثم يرسلها عامل بسرعة محدودة ويعيد المحاولة عند العطل العابر.
alter table messages
  add column chain           message_channel[] not null default '{}',
  add column attempts        integer not null default 0,
  add column next_attempt_at timestamptz;
create index messages_queue on messages(next_attempt_at) where status = 'QUEUED';
-- مرجع المزوّد يُبحث به عند وصول إشعار التسليم.
create index messages_provider_ref on messages(provider_ref) where provider_ref is not null;
