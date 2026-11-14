-- مراجعة النظام (التوزيع): بلاغات المزامنة دون اتصال، ومن عدّل المسودة ومن أرسلها.

-- تسليم دون اتصال لم يثبت ببرهان من رمز العائلة، وتسليم وقته في الجهاز خارج مدة الحملة.
alter type incident_kind add value if not exists 'UNPROVEN_OFFLINE';
alter type incident_kind add value if not exists 'BAD_CLOCK';

-- الاعتماد المزدوج: لا يعتمد الحملة من أنشأها، ولا من عدّل مسودتها آخراً، ولا من أرسلها.
alter table campaigns add column updated_by uuid references users(id);
alter table campaigns add column submitted_by uuid references users(id);

-- عدّ المحاولات الخاطئة للرمز الرقمي في آخر ساعة.
create index if not exists delivery_incidents_recent on delivery_incidents(kind, at desc);
