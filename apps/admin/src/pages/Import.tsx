import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, PageHeader } from '../components/ui';
import { useToast } from '../components/toast';
import { ApiError, api } from '../lib/api';
import { parseSheet, templateRows, type Cell, type ParsedFamily } from '../lib/importSheet';
import { FAMILY_STATUS, type FamilyStatus } from '../lib/labels';

type Outcome =
  | { kind: 'created'; id: string; familyNo: string; status: FamilyStatus }
  | { kind: 'failed'; message: string };
type Item = ParsedFamily & { opId: string; outcome?: Outcome };

const MAX_FAMILIES = 5000;

function failureText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'خطأ غير متوقع';
  const conflicts = (err.details as { conflicts?: { familyNo: string; personName?: string }[] } | null)?.conflicts;
  if (conflicts?.length) {
    return `مسجَّل سلفاً في العائلة ${[...new Set(conflicts.map((c) => c.familyNo))].join('، ')}`;
  }
  return err.message;
}

export function Import() {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [fileName, setFileName] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [fatal, setFatal] = useState('');
  const [unknown, setUnknown] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<'all' | 'errors' | 'failed'>('all');

  const valid = items.filter((f) => f.errors.length === 0);
  const invalid = items.length - valid.length;
  const created = items.filter((f) => f.outcome?.kind === 'created');
  const failed = items.filter((f) => f.outcome?.kind === 'failed');
  const pending = valid.filter((f) => f.outcome?.kind !== 'created');
  const done = created.length + failed.length;
  const flagged = created.filter((f) => f.outcome?.kind === 'created' && f.outcome.status === 'PENDING_DEDUPE_REVIEW').length;

  async function downloadTemplate() {
    const { default: writeXlsxFile } = await import('write-excel-file/browser');
    const rows = templateRows().map((r, i) => r.map((value) => ({ value, type: String, fontWeight: i === 0 ? ('bold' as const) : undefined })));
    await writeXlsxFile(rows, { sheet: 'العوائل', rightToLeft: true, stickyRowsCount: 1 }).toFile('قالب-استيراد-العوائل.xlsx');
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFatal(''); setItems([]); setUnknown([]); setFileName(file.name); setFilter('all');
    try {
      const { readSheet } = await import('read-excel-file/browser');
      const data = (await readSheet(file)) as unknown as Cell[][];
      const result = parseSheet(data);
      if (result.fatal) { setFatal(result.fatal); return; }
      if (result.families.length === 0) { setFatal('الورقة لا بيانات فيها تحت سطر العناوين.'); return; }
      if (result.families.length > MAX_FAMILIES) { setFatal(`في الملف ${result.families.length} عائلة. قسّمه إلى ملفات لا يزيد الواحد على ${MAX_FAMILIES}.`); return; }
      setUnknown(result.unknownColumns);
      setItems(result.families.map((f) => ({ ...f, opId: crypto.randomUUID() })));
    } catch {
      setFatal('تعذّرت قراءة الملف. يلزم أن يكون بصيغة xlsx (احفظه من Excel بـ«حفظ باسم» ← مصنف Excel).');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function run() {
    stop.current = false;
    setRunning(true);
    // واحدة بعد واحدة: كشف التكرار بين عوائل الملف نفسه يعتمد على أن السابقة قد حُفظت.
    for (const f of pending) {
      if (stop.current) break;
      let outcome: Outcome;
      try {
        const r = await api<{ id: string; familyNo: string; status: FamilyStatus }>('/families', { method: 'POST', body: { ...f.payload, clientOpId: f.opId } });
        outcome = { kind: 'created', id: r.id, familyNo: r.familyNo, status: r.status };
      } catch (err) {
        outcome = { kind: 'failed', message: failureText(err) };
        if (err instanceof ApiError && (err.status === 0 || err.status === 401)) {
          setItems((all) => all.map((x) => (x.opId === f.opId ? { ...x, outcome } : x)));
          toast('انقطع الاتصال. ما حُفظ محفوظ؛ اضغط «تابع» لإكمال الباقي.', 'error');
          break;
        }
      }
      setItems((all) => all.map((x) => (x.opId === f.opId ? { ...x, outcome } : x)));
    }
    setRunning(false);
    void qc.invalidateQueries({ queryKey: ['families'] });
  }

  const shown = items.filter((f) => (filter === 'errors' ? f.errors.length > 0 : filter === 'failed' ? f.outcome?.kind === 'failed' : true));
  const started = done > 0 || running;

  return (
    <>
      <PageHeader
        title="استيراد العوائل من Excel"
        description="لنقل السجلات القديمة دفعة واحدة. كل عائلة تمرّ بما يمرّ به التسجيل اليدوي: كشف التكرار ثم الاعتماد."
        action={<Link to="/families" className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 font-semibold hover:bg-ground">رجوع إلى العوائل</Link>}
      />

      <Card className="flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-1 ps-5">
          <li>نزّل القالب. كل سطر فرد، والأسطر التي تحمل «رقم الاستمارة» نفسه عائلة واحدة.</li>
          <li>الهاتف والعنوان والدخل والفئات تُكتب في سطر رب الأسرة وحده.</li>
          <li>ارفع الملف، وراجع ما يظهر، ثم ابدأ. لا يُحفظ شيء قبل أن تضغط «ابدأ الاستيراد».</li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void downloadTemplate()}>نزّل القالب</Button>
          <input ref={input} type="file" accept=".xlsx" className="sr-only" id="import-file" aria-label="ملف Excel" disabled={running} onChange={(e) => void onFile(e.target.files?.[0])} />
          <label htmlFor="import-file" className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-brand px-4 font-semibold text-white hover:bg-brand-strong focus-within:outline-2 ${running ? 'pointer-events-none opacity-60' : ''}`}>
            {items.length ? 'اختر ملفاً آخر' : 'اختر ملف Excel'}
          </label>
          {fileName && <span className="self-center text-muted">{fileName}</span>}
        </div>
      </Card>

      {fatal && <Alert>{fatal}</Alert>}
      {unknown.length > 0 && <Alert tone="warn">أعمدة لم تُعرف فأُهملت: {unknown.join('، ')}. إن كانت لازمة فسمِّها كما في القالب.</Alert>}

      {items.length > 0 && (
        <>
          <Card className="flex flex-col gap-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
              {[
                ['في الملف', items.length, ''], ['صالحة للاستيراد', valid.length, 'text-brand-strong'], ['فيها أخطاء', invalid, invalid ? 'text-danger' : ''],
                ['حُفظت', created.length, 'text-brand-strong'], ['رفضها النظام', failed.length, failed.length ? 'text-danger' : ''],
              ].map(([label, n, tone]) => (
                <div key={label as string} className="rounded-lg border border-line px-4 py-3">
                  <div className="text-sm text-muted">{label}</div>
                  <div className={`text-2xl font-bold tabular-nums ${tone}`}>{(n as number).toLocaleString('en-US')}</div>
                </div>
              ))}
            </div>
            {invalid > 0 && !started && (
              <Alert tone="warn">{invalid} استمارة فيها أخطاء ولن تُستورد. صحّحها في الملف وأعد رفعه، أو امضِ بالصالحة وأدخل الباقية لاحقاً.</Alert>
            )}
            {started && (
              <div aria-live="polite" className="flex flex-col gap-2">
                <div className="h-2.5 overflow-hidden rounded-full bg-ground" role="progressbar" aria-valuemin={0} aria-valuemax={valid.length} aria-valuenow={done} aria-label="تقدّم الاستيراد">
                  <div className="h-full bg-brand transition-[width]" style={{ width: `${valid.length ? (done / valid.length) * 100 : 0}%` }} />
                </div>
                <span className="text-muted">
                  {running ? `يُستورد… ${done} من ${valid.length}` : pending.length === failed.length ? `انتهى: حُفظت ${created.length} من ${valid.length}.` : `توقّف عند ${done} من ${valid.length}.`}
                  {flagged > 0 && ` منها ${flagged} عُلّقت لشبهة تكرار.`}
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {running
                ? <Button variant="secondary" onClick={() => { stop.current = true; }}>أوقف</Button>
                : <Button disabled={pending.length === 0} onClick={() => void run()}>{done === 0 ? `ابدأ الاستيراد (${valid.length})` : failed.length === pending.length ? `أعد محاولة المرفوضة (${failed.length})` : `تابع (${pending.length})`}</Button>}
              {created.length > 0 && !running && <Link to="/review" className="font-semibold text-brand-strong underline">إلى صف الاعتماد</Link>}
              <div className="ms-auto flex gap-2" role="group" aria-label="عرض">
                {([['all', 'الكل'], ['errors', `أخطاء الملف (${invalid})`], ['failed', `المرفوضة (${failed.length})`]] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${filter === k ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong hover:bg-ground'}`}>{label}</button>
                ))}
              </div>
            </div>
          </Card>

          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] border-collapse">
                <thead>
                  <tr className="text-sm text-muted">
                    {['الاستمارة', 'رب الأسرة', 'الأفراد', 'الحال'].map((h) => <th key={h} scope="col" className="border-b border-line px-4 py-3 text-start font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 300).map((f) => (
                    <tr key={f.opId} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-3 font-semibold tabular-nums">{f.form}<div className="text-sm font-normal text-muted">سطر {f.rows[0]}{f.rows.length > 1 && `–${f.rows[f.rows.length - 1]}`}</div></td>
                      <td className="px-4 py-3 font-semibold">{f.headName}</td>
                      <td className="px-4 py-3">{f.members}</td>
                      <td className="px-4 py-3">
                        {f.errors.length > 0 ? (
                          <ul className="flex flex-col gap-0.5 text-danger">{f.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                        ) : f.outcome?.kind === 'created' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={FAMILY_STATUS[f.outcome.status].tone}>{FAMILY_STATUS[f.outcome.status].label}</Badge>
                            <Link to={`/families/${f.outcome.id}`} className="font-semibold tabular-nums text-brand-strong underline">{f.outcome.familyNo}</Link>
                          </span>
                        ) : f.outcome?.kind === 'failed' ? (
                          <span className="text-danger">{f.outcome.message}</span>
                        ) : <span className="text-muted">جاهزة</span>}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-muted">لا شيء في هذا العرض.</td></tr>}
                </tbody>
              </table>
            </div>
            {shown.length > 300 && <p className="border-t border-line px-4 py-3 text-sm text-muted">يُعرض أول 300 من {shown.length}. استعمل أزرار العرض لترى الأخطاء وحدها.</p>}
          </Card>
        </>
      )}
    </>
  );
}
