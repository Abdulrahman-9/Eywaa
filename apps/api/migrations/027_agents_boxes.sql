-- ---------- المتعهدون ----------
-- هاتف الموظف. لازم للمتعهد: به يُعرَّف عند المتبرعين وأصحاب مواقع الصناديق، ويضعه المدير وحده.
alter table users add column phone text;

-- ---------- صناديق التبرعات ----------
-- صندوق في موقع من المدينة (محل، جامع، عيادة). يُفتح فيُعدّ ما فيه، ويدخل ذمة من فتحه حتى يسلّمه للمحاسب.
create type box_status as enum ('ACTIVE', 'RETIRED');
create sequence donation_box_seq;

create table donation_boxes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  location     text not null,
  address      text,
  host_name    text,
  host_phone   text,
  -- الصندوق المحاسبي الذي تدخله تحصيلاته.
  fund_id      uuid not null references funds(id),
  -- المتعهد المسؤول عن تحصيله. null: يحصّله من يكلَّف في حينه.
  agent_id     uuid references users(id),
  status       box_status not null default 'ACTIVE',
  installed_on date not null default current_date,
  note         text,
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  retired_at   timestamptz,
  retire_note  text
);
create index donation_boxes_agent on donation_boxes(agent_id) where status = 'ACTIVE';

-- كل فتح للصندوق، ولو وُجد فارغاً: به يُعرف «آخر فتح». المبلغ يدخل ذمة المحصِّل بقيد.
create table box_collections (
  id           uuid primary key default gen_random_uuid(),
  box_id       uuid not null references donation_boxes(id),
  amount       bigint not null check (amount >= 0),
  collected_at timestamptz not null,
  collected_by uuid not null references users(id),
  recorded_by  uuid not null references users(id),
  entry_id     uuid references ledger_entries(id),
  seal_no      text,
  note         text,
  -- فُتح في المركز أمام المحاسب: يدخل نقد الصندوق مباشرة ولا يمرّ بذمة أحد.
  direct       boolean not null default false,
  -- المعدَّل الذي قيس به هذا الفتح حين سُجّل (متوسط ما سبقه). null: لا سابق يكفي للقياس.
  expected     bigint,
  client_op_id uuid unique,
  created_at   timestamptz not null default now(),
  constraint collection_has_entry check ((amount > 0) = (entry_id is not null))
);
create index box_collections_box on box_collections(box_id, collected_at desc);
create index box_collections_by on box_collections(collected_by, collected_at desc);

-- ---------- تبرعات يسجّلها المتعهد ----------
-- المتعهد يتسلّم تبرعاً فيبلّغ الإدارة به باسم المساهم.
-- النقدي يدخل ذمته بقيد في حينه. والعيني يبقى «مبلَّغاً» حتى يستلمه أمين المخزن.
create type donation_kind as enum ('CASH', 'IN_KIND');
create type donation_status as enum ('REPORTED', 'RECEIVED', 'CANCELLED');
create sequence agent_donation_seq;

create table agent_donations (
  id            uuid primary key default gen_random_uuid(),
  no            integer not null default nextval('agent_donation_seq') unique,
  kind          donation_kind not null,
  agent_id      uuid not null references users(id),
  donor_name    text not null,
  donor_phone   text,
  donor_id      uuid references donors(id),
  purpose       text,
  note          text,
  -- النقدي
  fund_id       uuid references funds(id),
  amount        bigint check (amount > 0),
  entry_id      uuid references ledger_entries(id),
  -- العيني
  item_text     text,
  quantity      integer check (quantity > 0),
  unit          text,
  stock_move_id uuid references stock_moves(id),
  received_quantity integer,
  status        donation_status not null default 'REPORTED',
  received_by   uuid references users(id),
  received_at   timestamptz,
  close_note    text,
  reported_at   timestamptz not null,
  client_op_id  uuid unique,
  created_at    timestamptz not null default now(),
  constraint donation_shape check (
    (kind = 'CASH' and amount is not null and fund_id is not null and entry_id is not null and item_text is null) or
    (kind = 'IN_KIND' and item_text is not null and quantity is not null and amount is null)
  ),
  -- العيني لا يستلمه في المخزن من بلّغ به.
  constraint donation_received_by_other check (received_by is null or received_by <> agent_id)
);
create index agent_donations_agent on agent_donations(agent_id, reported_at desc);
create index agent_donations_open on agent_donations(reported_at) where status = 'REPORTED' and kind = 'IN_KIND';

-- رسالة شكر وإشعار للمتبرع بما سُجّل باسمه: إن سُجّل أقل مما أعطى علم.
-- ولصاحب موقع الصندوق رسالة بما عُدّ فيه عند كل فتح: شاهد على العدّ من خارج المركز.
alter table messages add column agent_donation_id uuid references agent_donations(id);
alter table messages add column box_collection_id uuid references box_collections(id);
alter table messages drop constraint message_has_target;
alter table messages add constraint message_has_target check (family_id is not null or quick_request_id is not null or agent_donation_id is not null or box_collection_id is not null);

-- ---------- مسؤول النقطة في الحملة ----------
-- متعهد يتولى نقطة ثابتة في حملة بعينها: عوائلها حصته فيها.
create table campaign_point_agents (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  point_id    uuid not null references distribution_points(id),
  agent_id    uuid not null references users(id),
  primary key (campaign_id, point_id)
);
create index campaign_point_agents_agent on campaign_point_agents(agent_id);

-- ---------- الذمة العينية ----------
-- ما حُوّل إلى مخزن المتعهد يؤكد هو استلامه، أو يبلّغ عن فرق فيه. المخزن يشهد بالتحويل، والمتعهد يشهد بالاستلام.
create table custody_acks (
  stock_move_id uuid primary key references stock_moves(id),
  agent_id      uuid not null references users(id),
  ok            boolean not null,
  note          text,
  at            timestamptz not null default now(),
  constraint dispute_has_note check (ok or note is not null)
);
