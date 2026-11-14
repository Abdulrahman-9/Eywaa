-- ---------- الكشف الميداني ----------
-- بعد تسجيل العائلة يُكلَّف بكشفها متعهد أو باحث، أو اثنان. كلٌّ يرفع تقريره بما وجد: مطابقة ما سُجّل، وملاحظاته، وتوصيته.
-- ثم يعتمد المدير الكشف فيقرّر أثره: لا أثر، أو رفع النقاط، أو خفضها، أو شطب العائلة.
create type inspection_status as enum ('ASSIGNED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');
-- توصية الكاشف. UNABLE: تعذّر الكشف (لم يجد العائلة مثلاً)، فلا تُعدّ العائلة به مكشوفة.
create type inspection_recommendation as enum ('CONFIRM', 'RAISE', 'LOWER', 'REMOVE', 'UNABLE');
create type inspection_contact as enum ('FAMILY', 'OTHERS', 'NONE');
create type inspection_effect as enum ('NONE', 'RAISED', 'LOWERED', 'REMOVED');
create sequence inspection_no_seq;

create table inspections (
  id            uuid primary key default gen_random_uuid(),
  no            integer not null default nextval('inspection_no_seq') unique,
  family_id     uuid not null references families(id),
  status        inspection_status not null default 'ASSIGNED',
  -- ما يطلب المدير التحقق منه خاصة.
  note          text,
  requested_by  uuid not null references users(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  effect        inspection_effect,
  -- كم رفع القرار أو خفض، وتعديل الكشف على العائلة قبله وبعده.
  points        integer check (points > 0),
  delta_before  integer,
  delta_after   integer,
  -- نقاط العائلة وفئتها قبل القرار وبعده، كما حُسبت ساعتها. null: العائلة لم تُعتمد بعد فلا نقاط لها.
  points_before integer,
  points_after  integer,
  class_before  char(1),
  class_after   char(1),
  constraint decided_complete check ((status in ('APPROVED', 'REJECTED')) = (decided_by is not null and decided_at is not null)),
  constraint approved_has_effect check ((status = 'APPROVED') = (effect is not null)),
  constraint move_has_points check ((effect in ('RAISED', 'LOWERED')) = (points is not null)),
  constraint rejected_has_note check (status <> 'REJECTED' or decision_note is not null)
);
-- للعائلة كشف قائم واحد.
create unique index inspections_one_open on inspections(family_id) where status in ('ASSIGNED', 'SUBMITTED');
create index inspections_family on inspections(family_id, requested_at desc);
create index inspections_status on inspections(status, requested_at);

-- تقرير كل كاشف. يُنشأ فارغاً عند التكليف، ويُملأ حين يرفعه صاحبه.
create table inspection_reports (
  id             uuid primary key default gen_random_uuid(),
  inspection_id  uuid not null references inspections(id) on delete cascade,
  inspector_id   uuid not null references users(id),
  submitted_at   timestamptz,
  visited_at     timestamptz,
  contact        inspection_contact,
  -- بنود المطابقة: [{ key, label, recorded, result: MATCH|MISMATCH|UNCHECKED, found }]. «recorded» ما كان في السجل ساعةَ الرفع.
  checks         jsonb not null default '[]',
  notes          text,
  recommendation inspection_recommendation,
  reason         text,
  client_op_id   uuid unique,
  unique (inspection_id, inspector_id),
  constraint report_complete check ((submitted_at is null) = (recommendation is null)),
  constraint report_has_contact check (submitted_at is null or (contact is not null and visited_at is not null)),
  -- ما يغيّر حال العائلة يلزمه سبب مكتوب.
  constraint report_has_reason check (recommendation is null or recommendation = 'CONFIRM' or reason is not null)
);
create index inspection_reports_inspector on inspection_reports(inspector_id) where submitted_at is null;

-- ---------- أثر الكشف في العائلة ----------
-- تعديل الكشف: نقاط تُضاف إلى مجموع المعادلة أو تُطرح منه، بقرار معتمَد وفي حدّ يضبطه المدير.
alter table families add column inspection_delta integer not null default 0 check (inspection_delta between -100 and 100);
-- متى اعتُمد آخر كشف عليها. null: غير مكشوفة.
alter table families add column inspected_at timestamptz;
alter table families add column removed_by uuid references users(id);
alter table families add column removed_at timestamptz;
alter table families add column remove_note text;
alter table families add constraint removed_complete check ((status = 'REMOVED') = (removed_at is not null and removed_by is not null and remove_note is not null));
create index families_inspected on families(inspected_at);

-- المجموع قبل تعديل الكشف، والتعديل نفسه: ليُعرض في «لماذا هذه النقاط؟».
alter table family_scores add column base_points integer;
alter table family_scores add column adjustment integer not null default 0;
update family_scores set base_points = points;
alter table family_scores alter column base_points set not null;

-- أقصى ما يرفعه الكشف أو يخفضه من نقاط العائلة. عشر نقاط نصف عرض الفئة بالحدود الأولى (70/50/30).
insert into settings (key, value) values ('inspection_max_delta', '10');
