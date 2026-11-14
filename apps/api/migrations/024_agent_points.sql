-- نقطة المتعهد: نقطة توزيع مربوطة بحسابه. حصته من الحملة هي ما عُيّن لنقطته، ولا يسلّم إلا منها.
alter table distribution_points add column agent_id uuid references users(id);
create unique index distribution_points_agent on distribution_points(agent_id) where agent_id is not null;
