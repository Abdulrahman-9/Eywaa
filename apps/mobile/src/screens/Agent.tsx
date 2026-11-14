import { useState } from 'react';
import { app, custodyOf, getState, useApp, type Box, type DonationOp, type GoodsTransfer } from '../lib/store';
import { Button, Field, Notice, Screen, SelectField, TextArea, digits, formatAgo, formatDayTime, formatNumber, formatTime } from '../ui';

const SYNC = { PENDING: ['ينتظر الرفع', 'text-warn-ink'], SYNCED: ['وصل الخادم', 'text-brand-strong'], REJECTED: ['ردّه الخادم', 'text-danger'] } as const;
const KIND_AR: Record<string, string> = { RECEIPT: 'دخل ذمتك', CUSTODY_RETURN: 'سلّمتَ المحاسب', CUSTODY_ISSUE: 'تسلّمتَ عهدة', REVERSAL: 'قيد عكس', SHORTAGE: 'عجز', OVERAGE: 'زيادة', DISBURSEMENT: 'صرف' };
const send = () => { if (getState().online) void app.sync(); };
const Sync = ({ sync }: { sync: keyof typeof SYNC }) => <span className={`font-semibold ${SYNC[sync][1]}`}>{SYNC[sync][0]}</span>;

/**
 * ذمة المتعهد: ما في يده من نقد المركز ومواده.
 * النقد دخل ذمته ساعةَ سجّله، ولا يخرج منها إلا بتسليم يسجّله المحاسب.
 */
export function Custody({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const info = s.agentInfo;
  const c = custodyOf(s);
  const [disputing, setDisputing] = useState<GoodsTransfer | null>(null);
  const [note, setNote] = useState('');
  const acked = (id: string) => s.acks.find((a) => a.moveId === id);
  const waiting = info?.goods.transfers.filter((t) => t.needsAck && !acked(t.id)) ?? [];

  async function ack(t: GoodsTransfer, ok: boolean, why?: string) {
    await app.addAck({ moveId: t.id, ok, note: why, item: t.item, quantity: t.quantity, unit: t.unit, sync: 'PENDING' });
    setDisputing(null); setNote('');
    send();
  }

  return (
    <Screen title="ذمتي" onBack={onBack}>
      {!info && <Notice tone="warn">زامن والجهاز متصل ليُحمَّل كشف ذمتك.</Notice>}
      <section aria-label="الذمة النقدية" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-baseline justify-between gap-3"><h2 className="text-lg font-bold">في ذمتك نقداً</h2><strong data-testid="custody" className="text-3xl tabular-nums">{formatNumber(c.total)}</strong></div>
        {c.unsent > 0 && <p className="font-semibold text-warn-ink">منها {formatNumber(c.unsent)} سجّلتَها ولم تُرفع بعد.</p>}
        {info && info.custody.funds.length > 1 && <p className="text-sm text-muted">{info.custody.funds.map((f) => `${f.fund}: ${formatNumber(f.balance)}`).join(' · ')}</p>}
        <p className="text-sm text-muted">سلّمها للمحاسب في المركز. يعدّها ويسجّل استلامها فتخرج من ذمتك ويصلك سندها.{info ? ` الكشف كما في ${formatDayTime(info.at)}.` : ''}</p>
      </section>

      {waiting.length > 0 && (
        <section aria-label="مواد تنتظر تأكيدك" className="flex flex-col gap-3 rounded-2xl border-2 border-[#C8862A] bg-warn-soft p-4">
          <h2 className="text-lg font-bold text-warn-ink">حُوّل إليك وينتظر تأكيدك ({waiting.length})</h2>
          {waiting.map((t) => (
            <div key={t.id} className="flex flex-col gap-2 rounded-xl bg-surface p-3">
              <p><strong>{formatNumber(t.quantity)} {t.unit} {t.item}</strong><br /><span className="text-sm text-muted">من {t.from} · {formatDayTime(t.at)}</span></p>
              {disputing?.id === t.id ? (
                <>
                  <TextArea label="ما الذي وجدتَه؟" hint="مثل: وصل 18 لا 20" value={note} onChange={(e) => setNote(e.target.value)} />
                  <div className="grid grid-cols-2 gap-3"><Button variant="secondary" onClick={() => setDisputing(null)}>رجوع</Button><Button variant="danger" disabled={note.trim().length < 3} onClick={() => void ack(t, false, note.trim())}>بلّغ عن الفرق</Button></div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3"><Button variant="secondary" onClick={() => { setDisputing(t); setNote(''); }}>فيها فرق</Button><Button onClick={() => void ack(t, true)}>استلمتُها كاملة</Button></div>
              )}
            </div>
          ))}
        </section>
      )}

      <section aria-label="المواد" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">مواد في عهدتك</h2>
        {(!info || info.goods.balances.length === 0) && <p className="text-muted">لا مواد عندك الآن.</p>}
        {info?.goods.balances.map((b) => <div key={b.itemId} className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0"><span className="font-semibold">{b.item}</span><span><strong className="tabular-nums">{formatNumber(b.quantity)}</strong> {b.unit}</span></div>)}
        {s.acks.filter((a) => a.sync !== 'SYNCED').map((a) => <p key={a.moveId} className="text-sm">{a.ok ? 'أكّدتَ استلام' : 'بلّغتَ عن فرق في'} {formatNumber(a.quantity)} {a.unit} {a.item} · <Sync sync={a.sync} />{a.error ? `: ${a.error}` : ''}</p>)}
      </section>

      {info && info.custody.lines.length > 0 && (
        <section aria-label="كشف الذمة" className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">آخر ما دخل ذمتك وخرج منها</h2>
          <ul className="flex flex-col gap-2">
            {info.custody.lines.slice(0, 20).map((l) => (
              <li key={l.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>{KIND_AR[l.kind] ?? l.kind}{l.pending ? ' (ينتظر الاعتماد)' : ''}</strong><strong className={`tabular-nums ${l.out ? 'text-brand-strong' : ''}`}>{l.out ? `− ${formatNumber(l.out)}` : `+ ${formatNumber(l.in)}`}</strong></div>
                <div className="text-sm text-muted">{l.party ?? l.description} · <bdi>{l.no}</bdi> · {formatDayTime(l.at)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Screen>
  );
}

/** صناديق التبرعات التي في عهدة المتعهد: يفتح الصندوق، يعدّ ما فيه، ويسجّله فيدخل ذمته. */
export function BoxesScreen({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const [box, setBox] = useState<Box | null>(null);
  const [f, setF] = useState({ amount: '', sealNo: '', note: '' });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const boxes = s.agentInfo?.boxes ?? [];
  const amount = Number(digits(f.amount)) || 0;
  const mineOf = (id: string) => s.collections.filter((c) => c.boxId === id);

  function review() {
    setError('');
    if (f.amount.trim() === '') return setError('اكتب ما عددتَه. إن وجدتَ الصندوق فارغاً فاكتب 0.');
    // من سجّل فتح صندوق ثم عاد إليه بعد دقائق فقد كرّر في الغالب.
    const recent = mineOf(box!.id).find((c) => c.sync !== 'REJECTED' && Date.now() - new Date(c.collectedAt).getTime() < 10 * 60_000);
    if (recent) return setError(`سجّلتَ فتح هذا الصندوق الساعة ${formatTime(recent.collectedAt)} بمبلغ ${formatNumber(recent.amount)}. لا يُسجَّل الفتح مرتين.`);
    setConfirming(true);
  }
  async function save() {
    const b = box!;
    await app.addCollection({ clientOpId: crypto.randomUUID(), boxId: b.id, code: b.code, location: b.location, amount, collectedAt: new Date().toISOString(), sealNo: f.sealNo.trim() || undefined, note: f.note.trim() || undefined, sync: 'PENDING' });
    setDone(amount ? `سُجّل فتح الصندوق ${b.code}: ${formatNumber(amount)} دينار دخلت ذمتك.` : `سُجّل فتح الصندوق ${b.code}: وُجد فارغاً.`);
    setBox(null); setConfirming(false); setF({ amount: '', sealNo: '', note: '' });
    send();
  }

  if (box && confirming) {
    return (
      <Screen title="تأكيد العدّ" onBack={() => setConfirming(false)}>
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface p-6 text-center">
          <p className="text-muted">صندوق {box.code} — {box.location}</p>
          <p className="text-5xl font-bold tabular-nums" data-testid="confirm-amount">{formatNumber(amount)}</p>
          <p className="text-lg">دينار عراقي</p>
        </div>
        <Notice tone={amount ? 'warn' : 'ok'}>{amount ? 'يدخل هذا المبلغ ذمتك حتى تسلّمه للمحاسب، ويُبلَّغ به صاحب الموقع. عُدَّه ثانيةً إن شككت.' : 'يُسجَّل أن الصندوق فُتح ووُجد فارغاً.'}</Notice>
        {box.expectedNow !== null && amount > 0 && amount < box.expectedNow * 0.5 && <Notice tone="warn">هذا دون نصف المعتاد لهذا الصندوق (نحو {formatNumber(box.expectedNow)}). إن صحّ العدّ فاكتب ما تراه سبباً في الملاحظة.</Notice>}
        <Button onClick={() => void save()}>نعم، سجّل {formatNumber(amount)}</Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>عدّل المبلغ</Button>
      </Screen>
    );
  }
  if (box) {
    return (
      <Screen title={`صندوق ${box.code}`} onBack={() => { setBox(null); setError(''); }}>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-lg font-bold">{box.location}</p>
          <p className="text-muted">{[box.address, box.hostName && `عند ${box.hostName}`].filter(Boolean).join(' · ') || 'بلا عنوان'}</p>
          <p className="text-sm text-muted">آخر فتح: {box.lastOpenedAt ? `${formatAgo(box.lastOpenedAt)} بمبلغ ${formatNumber(box.lastAmount ?? 0)}` : 'لم يُفتح بعد'}{box.expectedNow !== null ? ` · المعتاد الآن نحو ${formatNumber(box.expectedNow)}` : ''}</p>
        </div>
        {error && <Notice>{error}</Notice>}
        <Field label="ما عددتَه فيه بالدينار" hint="عُدَّه أمام صاحب الموقع إن أمكن. اكتب 0 إن وُجد فارغاً." inputMode="numeric" dir="ltr" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <Field label="رقم الختم (إن وُجد)" value={f.sealNo} onChange={(e) => setF({ ...f, sealNo: e.target.value })} />
        <Field label="ملاحظة (إن لزمت)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <Button onClick={review}>راجع ثم سجّل</Button>
      </Screen>
    );
  }
  return (
    <Screen title="صناديق التبرعات" onBack={onBack}>
      {done && <Notice tone="ok">{done}</Notice>}
      {!s.agentInfo && <Notice tone="warn">زامن والجهاز متصل لتُحمَّل صناديقك.</Notice>}
      {s.agentInfo && boxes.length === 0 && <Notice tone="warn">لا صندوق في عهدتك. يعيّنه لك المحاسب.</Notice>}
      <ul className="flex flex-col gap-3">
        {boxes.map((b) => {
          const pending = mineOf(b.id).filter((c) => c.sync === 'PENDING').length;
          return (
            <li key={b.id}>
              <button type="button" onClick={() => { setDone(''); setError(''); setBox(b); }} className={`flex w-full items-center gap-3 rounded-2xl border bg-surface p-4 text-start active:bg-ground ${b.stale ? 'border-2 border-[#C8862A]' : 'border-line'}`}>
                <span className="grid size-12 flex-none place-items-center rounded-xl bg-brand-soft text-lg font-bold text-brand-strong tabular-nums">{b.code}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-bold">{b.location}</span>
                  <span className="block text-sm text-muted">{pending ? 'سجّلتَ فتحه وينتظر الرفع' : b.lastOpenedAt ? `فُتح ${formatAgo(b.lastOpenedAt)}: ${formatNumber(b.lastAmount ?? 0)}` : 'لم يُفتح بعد'}</span>
                  {b.stale && !pending && <span className="block text-sm font-semibold text-warn-ink">لم يُفتح منذ {b.daysSince} يوماً</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {s.collections.length > 0 && (
        <>
          <h2 className="text-lg font-bold">ما سجّلتَه من هذا الهاتف</h2>
          <ul className="flex flex-col gap-2">
            {[...s.collections].reverse().map((c) => (
              <li key={c.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>صندوق {c.code} — {c.location}</strong><strong className="tabular-nums">{formatNumber(c.amount)}</strong></div>
                <div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-muted">{formatDayTime(c.collectedAt)}{c.entryNo ? ` · سند ${c.entryNo}` : ''}</span><Sync sync={c.sync} /></div>
                {c.low && <span className="text-sm text-warn-ink">دون المعتاد لهذا الصندوق: قد تُسأل عنه.</span>}
                {c.sync === 'REJECTED' && <><span className="text-sm text-danger">{c.error}</span><Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropOp('collections', c.clientOpId)}>أزله من الجهاز</Button></>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}

/** تبرع تسلّمه المتعهد باسم المركز: نقدي يدخل ذمته، أو عيني يبلّغ به حتى يستلمه المخزن. */
export function Donate({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const funds = s.agentInfo?.funds ?? [];
  const [kind, setKind] = useState<'CASH' | 'IN_KIND'>('CASH');
  const [f, setF] = useState({ donorName: '', donorPhone: '', amount: '', fundId: '', itemText: '', quantity: '', unit: '', purpose: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setError(''); setDone('');
    const donorName = f.donorName.trim();
    if (donorName.length < 2) return setError('اكتب اسم المتبرع، أو اختر «فاعل خير».');
    const phone = digits(f.donorPhone);
    if (phone && !/^(0|964|00964)?7\d{9}$/.test(phone)) return setError('رقم هاتف المتبرع غير صالح. صحّحه أو احذفه.');
    const base = { clientOpId: crypto.randomUUID(), donorName, donorPhone: phone || undefined, purpose: f.purpose.trim() || undefined, reportedAt: new Date().toISOString(), sync: 'PENDING' as const };
    let op: DonationOp;
    if (kind === 'CASH') {
      const amount = Number(digits(f.amount));
      if (!amount) return setError('اكتب المبلغ.');
      op = { ...base, kind, amount, fundId: f.fundId || undefined, fundName: funds.find((x) => x.id === f.fundId)?.name };
    } else {
      const quantity = Number(digits(f.quantity));
      if (f.itemText.trim().length < 2 || !quantity) return setError('اكتب ما تبرّع به وكميته.');
      op = { ...base, kind, itemText: f.itemText.trim(), quantity, unit: f.unit.trim() || undefined };
    }
    await app.addDonation(op);
    setDone(kind === 'CASH' ? `سُجّل: ${formatNumber(op.amount!)} دينار من ${donorName}، ودخلت ذمتك.` : `بُلّغ: ${op.quantity} ${op.unit ?? ''} ${op.itemText} من ${donorName}. سلّمه للمخزن.`);
    setF({ donorName: '', donorPhone: '', amount: '', fundId: '', itemText: '', quantity: '', unit: '', purpose: '' });
    send();
  }

  return (
    <Screen title="تبرع جديد" onBack={onBack}>
      {error && <Notice>{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <div role="group" aria-label="نوع التبرع" className="grid grid-cols-2 gap-2 rounded-2xl bg-ground p-1">
        {([['CASH', 'نقدي'], ['IN_KIND', 'عيني']] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`min-h-12 rounded-xl text-lg font-semibold ${kind === k ? 'bg-brand text-white' : 'text-muted'}`}>{label}</button>
        ))}
      </div>
      <Field label="اسم المتبرع" hint="يُشكر برسالة فيها ما سُجّل باسمه إن كتبتَ هاتفه." value={f.donorName} onChange={set('donorName')} />
      <button type="button" className="-mt-2 self-start font-semibold text-brand-strong underline" onClick={() => setF({ ...f, donorName: 'فاعل خير' })}>لا يريد ذكر اسمه: فاعل خير</button>
      <Field label="هاتف المتبرع (إن تيسّر)" type="tel" inputMode="tel" dir="ltr" value={f.donorPhone} onChange={set('donorPhone')} />
      {kind === 'CASH' ? (
        <>
          <Field label="المبلغ بالدينار" inputMode="numeric" dir="ltr" value={f.amount} onChange={set('amount')} />
          {funds.length > 1 && <SelectField label="يدخل صندوق" value={f.fundId} onChange={set('fundId')}><option value="">الصندوق العام</option>{funds.map((x) => <option key={x.id} value={x.id}>{x.name}{x.program ? ` (لـ${x.program})` : ''}</option>)}</SelectField>}
        </>
      ) : (
        <>
          <Field label="ما تبرّع به" hint="مثل: طحين صفر، بطانيات، لحم" value={f.itemText} onChange={set('itemText')} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="الكمية" inputMode="numeric" dir="ltr" value={f.quantity} onChange={set('quantity')} />
            <Field label="الوحدة" hint="كيس، كغم، قطعة" value={f.unit} onChange={set('unit')} />
          </div>
        </>
      )}
      <Field label="فيمَ يريده (إن ذكر)" hint="مثل: للأيتام، كفالة، زكاة" value={f.purpose} onChange={set('purpose')} />
      <Button onClick={() => void save()}>{kind === 'CASH' ? 'سجّل التبرع' : 'بلّغ بالتبرع'}</Button>
      {s.donations.length > 0 && (
        <>
          <h2 className="text-lg font-bold">ما سجّلتَه من هذا الهاتف</h2>
          <ul className="flex flex-col gap-2">
            {[...s.donations].reverse().map((d) => (
              <li key={d.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>{d.donorName}</strong><strong className="tabular-nums">{d.kind === 'CASH' ? formatNumber(d.amount ?? 0) : `${d.quantity} ${d.unit ?? ''} ${d.itemText}`}</strong></div>
                <div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-muted">{d.kind === 'CASH' ? 'نقدي' : 'عيني'} · {formatDayTime(d.reportedAt)}{d.entryNo ? ` · سند ${d.entryNo}` : d.no ? ` · بلاغ ${d.no}` : ''}</span><Sync sync={d.sync} /></div>
                {d.sync === 'REJECTED' && <><span className="text-sm text-danger">{d.error}</span><Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropOp('donations', d.clientOpId)}>أزله من الجهاز</Button></>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}

const QUICK_AR: Record<string, string> = { NEW: 'عند المشرف', INVITED: 'دُعي صاحبه للحضور', VISIT_ASSIGNED: 'أُسندت زيارته لباحث', COMPLETED: 'سُجّلت العائلة', DISMISSED: 'صُرف النظر عنه' };
const EDIT_AR: Record<string, string> = { OPEN: 'ينتظر زيارة باحث', VISITED: 'زيرت وتنتظر الاعتماد', CLOSED: 'أُغلق', CANCELLED: 'أُلغي' };

/** طلبات المتعهد: عائلة رآها تستحق فيطلب إضافتها، أو عائلة مسجَّلة تغيّر حالها فيطلب تعديلها. لا يسجّل ولا يعدّل هو. */
export function Requests({ onBack }: { onBack: () => void }) {
  const s = useApp();
  const [kind, setKind] = useState<'ADD' | 'EDIT'>('ADD');
  const [f, setF] = useState({ headName: '', phone: '', mahalla: '', members: '', note: '', familyNo: '', reason: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const server = s.agentInfo?.requests;

  async function save() {
    setError(''); setDone('');
    const base = { clientOpId: crypto.randomUUID(), createdAt: new Date().toISOString(), sync: 'PENDING' as const };
    if (kind === 'ADD') {
      const headName = f.headName.trim();
      if (headName.split(/\s+/).length < 2) return setError('اكتب اسم رب الأسرة ثنائياً على الأقل. كلما اكتمل سهل الوصول إليه.');
      const phone = digits(f.phone);
      if (phone && !/^(0|964|00964)?7\d{9}$/.test(phone)) return setError('رقم الهاتف غير صالح. صحّحه أو احذفه.');
      await app.addRequest({ ...base, kind, headName, phone: phone || undefined, mahalla: f.mahalla.trim() || undefined, membersCount: Number(digits(f.members)) || undefined, note: f.note.trim() || undefined });
      setDone(`رُفع طلب إضافة «${headName}». يستكمله المشرف بدعوة أو زيارة.`);
    } else {
      const familyNo = digits(f.familyNo);
      if (familyNo.length < 2) return setError('اكتب رقم العائلة كما في بطاقتها.');
      if (f.reason.trim().length < 5) return setError('اكتب ما تغيّر في حال العائلة.');
      await app.addRequest({ ...base, kind, familyNo, reason: f.reason.trim() });
      setDone(`رُفع طلب تعديل العائلة ${familyNo}. يزورها باحث ثم يُعتمد التعديل.`);
    }
    setF({ headName: '', phone: '', mahalla: '', members: '', note: '', familyNo: '', reason: '' });
    send();
  }

  return (
    <Screen title="طلباتي" onBack={onBack}>
      {error && <Notice>{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <div role="group" aria-label="نوع الطلب" className="grid grid-cols-2 gap-2 rounded-2xl bg-ground p-1">
        {([['ADD', 'إضافة عائلة'], ['EDIT', 'تعديل عائلة']] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setError(''); }} className={`min-h-12 rounded-xl text-lg font-semibold ${kind === k ? 'bg-brand text-white' : 'text-muted'}`}>{label}</button>
        ))}
      </div>
      {kind === 'ADD' ? (
        <>
          <Field label="اسم رب الأسرة" hint="الاسم وحده لازم. والباقي يعين من يستكمل التسجيل." value={f.headName} onChange={set('headName')} />
          <Field label="الهاتف (إن تيسّر)" type="tel" inputMode="tel" dir="ltr" value={f.phone} onChange={set('phone')} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="المحلة" value={f.mahalla} onChange={set('mahalla')} />
            <Field label="عدد الأفراد" inputMode="numeric" dir="ltr" value={f.members} onChange={set('members')} />
          </div>
          <TextArea label="ما رأيتَه من حالهم" hint="مثل: أرملة وخمسة أيتام في بيت إيجار" value={f.note} onChange={set('note')} />
        </>
      ) : (
        <>
          <Field label="رقم العائلة" hint="كما في بطاقتها أو رسالة دعوتها" inputMode="numeric" dir="ltr" value={f.familyNo} onChange={set('familyNo')} />
          <TextArea label="ما الذي تغيّر؟" hint="مثل: توفي رب الأسرة، انتقلوا إلى حي آخر، تغيّر هاتفهم" value={f.reason} onChange={set('reason')} />
        </>
      )}
      <Button onClick={() => void save()}>ارفع الطلب</Button>

      {s.requests.filter((r) => r.sync !== 'SYNCED').length > 0 && (
        <ul className="flex flex-col gap-2">
          {s.requests.filter((r) => r.sync !== 'SYNCED').reverse().map((r) => (
            <li key={r.clientOpId} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
              <div className="flex items-baseline justify-between gap-2"><strong>{r.kind === 'ADD' ? `إضافة: ${r.headName}` : `تعديل العائلة ${r.familyNo}`}</strong><Sync sync={r.sync} /></div>
              {r.sync === 'REJECTED' && <><span className="text-sm text-danger">{r.error}</span><Button variant="secondary" className="min-h-11 self-start text-base" onClick={() => void app.dropOp('requests', r.clientOpId)}>أزله من الجهاز</Button></>}
            </li>
          ))}
        </ul>
      )}
      {server && server.additions.length + server.edits.length > 0 && (
        <>
          <h2 className="text-lg font-bold">ما آلت إليه طلباتك</h2>
          <ul className="flex flex-col gap-2">
            {server.additions.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-2"><strong>إضافة: {r.headName}</strong><span className="text-sm text-muted">طلب {r.no}</span></div>
                <div className="text-sm"><span className="font-semibold text-brand-strong">{QUICK_AR[r.status] ?? r.status}</span>{r.familyNo ? ` · صارت العائلة ${r.familyNo}` : ''}{r.note ? ` · ${r.note}` : ''}</div>
              </li>
            ))}
            {server.edits.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <strong>تعديل العائلة {r.familyNo}</strong>
                <div className="text-sm"><span className="font-semibold text-brand-strong">{EDIT_AR[r.status] ?? r.status}</span> · {r.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}
