-- كيف دخلت العائلة الحملة: بالقاعدة، أو بترشيح النظام لإكمال العدد، أو باليد.
create type pick_source as enum ('RULE', 'NOMINATED', 'MANUAL');
alter table entitlements add column picked_by pick_source not null default 'RULE';
