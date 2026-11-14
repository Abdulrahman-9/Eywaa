-- ---------- إصدارات معادلة النقاط ----------
create type scoring_status as enum ('PENDING', 'ACTIVE', 'RETIRED', 'REJECTED');

create table scoring_versions (
  version       integer primary key,
  status        scoring_status not null,
  criteria      jsonb not null,
  thresholds    jsonb not null,
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  constraint scoring_decided_by_other check (decided_by is null or created_by is null or decided_by <> created_by)
);
create unique index one_active_scoring on scoring_versions ((true)) where status = 'ACTIVE';
create unique index one_pending_scoring on scoring_versions ((true)) where status = 'PENDING';

-- الإصدار 1: القيم الأولية المعتمدة في الخطة (9.4).
insert into scoring_versions (version, status, criteria, thresholds, note) values (
  1, 'ACTIVE',
  '{
    "income":       {"max": 25},
    "orphans":      {"perUnit": 5, "max": 15},
    "housing":      {"OWNED": 0, "RENTED": 10, "OTHER": 12},
    "disabled":     {"perUnit": 6, "max": 12},
    "femaleHead":   {"max": 10},
    "familySize":   {"perUnit": 2, "above": 3, "max": 10},
    "chronic":      {"perUnit": 4, "max": 8},
    "noIncome":     {"max": 8}
  }',
  '{"a": 70, "b": 50, "c": 30}',
  'القيم الأولية'
);

-- ---------- نقاط كل عائلة بحسب الإصدار الساري ----------
create table family_scores (
  family_id   uuid primary key references families(id),
  version     integer not null references scoring_versions(version),
  points      integer not null,
  class       char(1) not null check (class in ('A', 'B', 'C', 'D')),
  breakdown   jsonb not null,
  computed_at timestamptz not null default now()
);
create index family_scores_class on family_scores(class);
