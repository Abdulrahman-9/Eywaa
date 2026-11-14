-- ---------- مراجعة النظام: ضوابط الدفتر ----------
-- قيد العكس المرفوض لا يمنع عكساً لاحقاً صحيحاً: الفرادة لما لم يُرفض وحده.
alter table ledger_entries drop constraint ledger_entries_reverses_key;
create unique index ledger_entries_reverses_live on ledger_entries(reverses) where status <> 'REJECTED';

-- القيد نفسه لا يُحذف ولا يُبدَّل مبلغه ولا صندوقه ولا نوعه؛ يتغيّر منه قرار اعتماده ونسبته إلى متبرعه فقط، ومرة واحدة.
create function ledger_entry_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'ledger entries are never deleted'; end if;
  if (new.no, new.kind, new.fund_id, new.amount, new.description, new.created_by, new.created_at)
       is distinct from (old.no, old.kind, old.fund_id, old.amount, old.description, old.created_by, old.created_at)
     or new.party is distinct from old.party or new.category is distinct from old.category
     or new.custody_user is distinct from old.custody_user or new.entitlement_id is distinct from old.entitlement_id
     or new.reverses is distinct from old.reverses then
    raise exception 'ledger entries are immutable';
  end if;
  if old.status <> 'PENDING' and new.status <> old.status then raise exception 'a decided ledger entry keeps its status'; end if;
  return new;
end $$;
create trigger ledger_entries_guard before update or delete on ledger_entries
  for each row execute function ledger_entry_guard();

create function no_truncate() returns trigger language plpgsql as $$
begin
  raise exception '% is never truncated', tg_table_name;
end $$;
create trigger ledger_entries_no_truncate before truncate on ledger_entries for each statement execute function no_truncate();
create trigger ledger_lines_no_truncate before truncate on ledger_lines for each statement execute function no_truncate();

-- حركات المخزون تُجمع بالمخزن في كل قراءة للأرصدة.
create index if not exists stock_moves_to_wh on stock_moves(to_wh, item_id) where status = 'POSTED';
create index if not exists stock_moves_from_wh on stock_moves(from_wh, item_id) where status = 'POSTED';
