create extension if not exists pg_trgm;

-- ---------- المستخدمون ----------
create type user_role as enum (
  'ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER',
  'DISTRIBUTOR', 'STOREKEEPER', 'ACCOUNTANT', 'PROJECT_SUPERVISOR', 'AUDITOR'
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  full_name     text not null,
  password_hash text not null,
  role          user_role not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- سجل التدقيق: يُضاف إليه ولا يُعدَّل ----------
create table audit_log (
  seq       bigserial primary key,
  at        timestamptz not null,
  actor_id  uuid references users(id),
  action    text not null,
  entity    text not null,
  entity_id text not null,
  payload   jsonb not null default '{}',
  prev_hash text not null,
  hash      text not null
);

create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_no_change before update or delete on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_immutable();

-- ---------- العوائل ----------
create type family_status as enum (
  'PENDING_DEDUPE_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'
);
create type housing_type as enum ('OWNED', 'RENTED', 'OTHER');
create type family_tag as enum (
  'ORPHANS', 'WIDOW', 'DISABLED', 'SICK', 'DIVORCED', 'NEEDY', 'UNMARRIED'
);

create sequence family_no_seq start 100000;

create table families (
  id                 uuid primary key default gen_random_uuid(),
  family_no          text not null unique,
  status             family_status not null,
  tags               family_tag[] not null default '{}',
  phone1             text,
  phone2             text,
  mahalla            text,
  street             text,
  house              text,
  landmark           text,
  housing            housing_type,
  housing_other      text,
  prev_address       text,
  prev_landmark      text,
  residence_card_no  text,
  residence_card_at  date,
  residence_card_by  text,
  ration_hash        text unique,
  ration_enc         text,
  ration_issued_at   date,
  ration_center      text,
  lat                double precision,
  lng                double precision,
  notes              text,
  client_op_id       uuid unique,
  created_by         uuid not null references users(id),
  created_at         timestamptz not null default now(),
  decided_by         uuid references users(id),
  decided_at         timestamptz,
  decision_note      text,
  constraint decided_by_other check (decided_by is null or decided_by <> created_by)
);
create index families_phone1 on families(phone1);
create index families_phone2 on families(phone2);

-- ---------- الأفراد ----------
create type person_relation as enum (
  'HEAD', 'SPOUSE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'BROTHER', 'SISTER', 'OTHER'
);
create type gender as enum ('M', 'F');
create type person_status as enum ('ACTIVE', 'DECEASED');

create table persons (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references families(id),
  relation        person_relation not null,
  status          person_status not null default 'ACTIVE',
  full_name       text not null,
  name_norm       text not null,
  mother_name     text,
  mother_norm     text,
  gender          gender not null,
  birth_date      date,
  is_orphan       boolean not null default false,
  disability      text,
  chronic_illness text
);
create index persons_family on persons(family_id);
create index persons_name_trgm on persons using gin (name_norm gin_trgm_ops);
create unique index one_head_per_family on persons(family_id) where relation = 'HEAD';

-- ---------- وثائق الهوية ----------
-- NATIONAL_CARD: البطاقة الوطنية الموحدة (12 خانة)
-- CIVIL_ID: هوية الأحوال المدنية القديمة (رقم + سجل + صفحة)
-- NATIONALITY_CERT: شهادة الجنسية (رقم + محفظة)
create type id_doc_type as enum ('NATIONAL_CARD', 'CIVIL_ID', 'NATIONALITY_CERT');

create table person_documents (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references persons(id),
  type       id_doc_type not null,
  key_hash   text not null unique,   -- بصمة HMAC: بها تُفرض الفرادة ويُبحث
  number_enc text not null,          -- الرقم مشفّراً AES-256-GCM
  register   text,
  page       text,
  portfolio  text,
  issued_at  date
);
create index person_documents_person on person_documents(person_id);

-- ---------- مصادر الدخل ----------
create type income_kind as enum ('SALARY', 'PENSION', 'SOCIAL_WELFARE', 'WORK', 'OTHER_AID');

create table income_sources (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references families(id),
  kind       income_kind not null,
  amount_iqd integer not null check (amount_iqd >= 0),
  note       text
);
create index income_sources_family on income_sources(family_id);

-- ---------- الوكلاء ----------
create table proxies (
  id        uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  full_name text not null,
  phone     text,
  relation  text,
  active    boolean not null default true
);
create index proxies_family on proxies(family_id);

-- ---------- شبهات التكرار ----------
create type flag_status as enum ('OPEN', 'DISMISSED', 'CONFIRMED');

create table duplicate_flags (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references families(id),
  person_id         uuid not null references persons(id),
  matched_person_id uuid not null references persons(id),
  matched_family_id uuid not null references families(id),
  reason            text not null,
  score             real not null,
  status            flag_status not null default 'OPEN',
  resolved_by       uuid references users(id),
  resolved_at       timestamptz,
  note              text
);
create index duplicate_flags_family on duplicate_flags(family_id);
