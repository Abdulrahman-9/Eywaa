-- ---------- الأصناف والمخازن ----------
create table items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  unit       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table warehouses (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  point_id uuid unique references distribution_points(id)   -- null: المخزن الرئيس
);
insert into warehouses (name) values ('المخزن الرئيس');

-- البرنامج العيني يُربط بصنفه، فيُخصم من مخزن النقطة عند كل تسليم.
alter table programs add column item_id uuid references items(id);

-- ---------- حركات المخزون ----------
create type move_kind as enum ('RECEIPT', 'TRANSFER', 'ISSUE', 'RETURN', 'WASTE', 'ADJUST');
create type move_status as enum ('POSTED', 'PENDING', 'REJECTED');

create table stock_moves (
  id             uuid primary key default gen_random_uuid(),
  kind           move_kind not null,
  status         move_status not null default 'POSTED',
  item_id        uuid not null references items(id),
  from_wh        uuid references warehouses(id),
  to_wh          uuid references warehouses(id),
  quantity       integer not null check (quantity > 0),
  expiry         date,
  source         text,                      -- المورّد أو المتبرع في الوارد
  campaign_id    uuid references campaigns(id),
  entitlement_id uuid unique references entitlements(id),
  note           text,
  created_by     uuid not null references users(id),
  created_at     timestamptz not null default now(),
  decided_by     uuid references users(id),
  decided_at     timestamptz,
  decision_note  text,
  constraint move_decided_by_other check (decided_by is null or decided_by <> created_by),
  -- لكل نوع جهته: الوارد يدخل، والصادر والتالف يخرجان، والتحويل والراجع بين مخزنين، والتسوية في جهة واحدة.
  constraint move_shape check (
    (kind = 'RECEIPT' and from_wh is null and to_wh is not null) or
    (kind in ('ISSUE', 'WASTE') and from_wh is not null and to_wh is null) or
    (kind in ('TRANSFER', 'RETURN') and from_wh is not null and to_wh is not null and from_wh <> to_wh) or
    (kind = 'ADJUST' and ((from_wh is null) <> (to_wh is null)))
  )
);
create index stock_moves_item on stock_moves(item_id, created_at desc);
create index stock_moves_campaign on stock_moves(campaign_id);

-- الرصيد: ما دخل المخزن ناقصاً ما خرج منه، من الحركات المثبَّتة فقط.
create view stock_balances as
  select w.id as warehouse_id, i.id as item_id,
         coalesce(sum(case when m.to_wh = w.id then m.quantity when m.from_wh = w.id then -m.quantity end), 0)::int as quantity
  from warehouses w cross join items i
    left join stock_moves m on m.item_id = i.id and m.status = 'POSTED' and (m.to_wh = w.id or m.from_wh = w.id)
  group by w.id, i.id;
