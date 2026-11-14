import { MessageSquarePlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Badge, Button, Chip, Dialog, Field, Input } from '../src/components/ui';
import { formatDateTime } from '../src/lib/format';
import { NAV } from '../src/lib/roles';

type Kind = 'NOTE' | 'BUG' | 'IDEA';
interface Note { id: string; text: string; kind: Kind; screen: string; route: string; name: string; at: number }
const KIND_AR: Record<Kind, string> = { NOTE: 'ملاحظة', BUG: 'خطأ', IDEA: 'اقتراح' };
const KIND_TONE: Record<Kind, 'neutral' | 'danger' | 'info'> = { NOTE: 'neutral', BUG: 'danger', IDEA: 'info' };
const NOTES = 'eywaa.demo.notes', NAME = 'eywaa.demo.name', ROUTE = 'eywaa.demo.route';

// تخزين المتصفح قد يُمنع داخل الإطار: كل قراءة وكتابة تحتمل الإخفاق، والنسخة تعمل بلا حفظ.
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* بلا حفظ */ } };
export const lastRoute = () => load<string>(ROUTE, '/');

/** اسم الشاشة كما يعرفه المجرّب، ليُكتب مع ملاحظته. */
function screenOf(path: string): string {
  const exact = NAV.find((n) => n.to === path);
  if (exact) return exact.label;
  const rules: [RegExp, string][] = [
    [/^\/families\/new/, 'تسجيل عائلة'], [/^\/families\/import/, 'استيراد العوائل'], [/^\/families\//, 'ملف عائلة'],
    [/^\/campaigns\/new/, 'تحضير حملة'], [/^\/campaigns\/[^/]+\/edit/, 'تعديل مسودة حملة'], [/^\/campaigns\/[^/]+\/tokens/, 'بطاقات الرموز'], [/^\/campaigns\//, 'صفحة حملة'],
    [/^\/agents\//, 'ملف متعهد'], [/^\/cashbox\/funds\//, 'كشف حساب صندوق'], [/^\/housing\//, 'مشروع بناء'],
  ];
  return rules.find(([re]) => re.test(path))?.[1] ?? path;
}

interface Shared { db: any; canWrite: boolean; notes: Note[] | null; slow: boolean }

/** السجل المشترك للملاحظات، إن أتاحه الحاضن لهذا الزائر. يُشترك مرة واحدة، ويُمهل عشر ثوانٍ. */
function useShared(): Shared {
  const [s, setS] = useState<Shared>({ db: null, canWrite: false, notes: null, slow: false });
  useEffect(() => {
    let off: (() => void) | undefined, dead = false, timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const claude = (window as any).claude;
      const db = claude ? await claude.use('db').catch(() => null) : null;
      if (dead || !db) return;
      const user = await claude.use('user').catch(() => null);
      const can = user ? await user.can('data.write').catch(() => null) : null;
      if (dead) return;
      setS((x) => ({ ...x, db, canWrite: can !== false }));
      timer = setTimeout(() => setS((x) => (x.notes ? x : { ...x, slow: true })), 10_000);
      off = db.collection('notes').orderBy('at', 'desc').limit(300).onSnapshot(
        (snap: any) => { if (!snap.metadata.fromCache) clearTimeout(timer); setS((x) => ({ ...x, slow: false, notes: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) })); },
        () => { clearTimeout(timer); setS((x) => ({ ...x, db: null, slow: false })); },
      );
    })();
    return () => { dead = true; clearTimeout(timer); off?.(); };
  }, []);
  return s;
}

function NoteRow({ n, onDelete }: { n: Note; onDelete?: () => void }) {
  return (
    <li className="flex flex-col gap-1 border-b border-line pb-3 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Badge tone={KIND_TONE[n.kind]}>{KIND_AR[n.kind]}</Badge>
        <span className="font-semibold text-ink">{n.screen}</span>
        <span>{n.name || 'بلا اسم'} · {formatDateTime(new Date(n.at).toISOString())}</span>
        {onDelete && <button type="button" onClick={onDelete} className="ms-auto min-h-9 font-semibold text-danger underline">احذف</button>}
      </div>
      <p className="whitespace-pre-wrap break-words">{n.text}</p>
    </li>
  );
}

export function DemoChrome({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<Note[]>(() => load<Note[]>(NOTES, []));
  const [name, setName] = useState(() => load<string>(NAME, ''));
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('NOTE');
  const [saved, setSaved] = useState<'LOCAL' | 'SHARED' | null>(null);
  const [refused, setRefused] = useState(false);
  const [copied, setCopied] = useState<'YES' | 'MANUAL' | null>(null);
  const manual = useRef<HTMLTextAreaElement>(null);
  const shared = useShared();
  const central = !!shared.db && shared.canWrite && !refused;
  const screen = screenOf(pathname);

  useEffect(() => { keep(ROUTE, pathname); }, [pathname]);
  useEffect(() => { if (copied === 'MANUAL') manual.current?.select(); }, [copied]);

  const persist = (list: Note[]) => { setMine(list); keep(NOTES, list); };
  const save = async () => {
    const n: Note = { id: crypto.randomUUID(), text: text.trim(), kind, screen, route: pathname, name: name.trim(), at: Date.now() };
    persist([n, ...mine]);
    keep(NAME, n.name);
    setText('');
    setCopied(null);
    setSaved('LOCAL');
    if (!central) return;
    try {
      const { id, ...body } = n;
      await shared.db.collection('notes').doc(id).set(body);
      setSaved('SHARED');
    } catch {
      // هذا الزائر لا يملك الكتابة في السجل المشترك: تبقى ملاحظاته عنده، وينسخها.
      setRefused(true);
    }
  };
  const all = () => [`ملاحظات على نسخة تجربة «إيواء»${name.trim() ? ` · ${name.trim()}` : ''}`, ...[...mine].reverse().map((n, i) => `${i + 1}) [${KIND_AR[n.kind]}] ${n.screen}: ${n.text}`)].join('\n');
  const copy = async () => {
    try { await navigator.clipboard.writeText(all()); setCopied('YES'); } catch { setCopied('MANUAL'); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-nav px-4 py-2 text-sm text-nav-ink" data-testid="demo-ribbon">
        <span className="rounded-full bg-warm px-2.5 py-0.5 font-bold text-white">نسخة للتجربة</span>
        <span className="hidden sm:inline">بيانات وهمية لمركز افتراضي. دخلتَ بصفة <strong>مدير النظام</strong>. ما تغيّره لا يُحفظ.</span>
        <span className="sm:hidden">بيانات وهمية، ولا يُحفظ التغيير.</span>
        <button type="button" onClick={() => setOpen(true)} className="ms-auto min-h-9 font-bold underline underline-offset-4">اكتب ملاحظة{mine.length ? ` (${mine.length})` : ''}</button>
      </div>
      {children}
      <button type="button" onClick={() => setOpen(true)} aria-label="اكتب ملاحظة على هذه الشاشة"
        className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] left-[calc(1rem+env(safe-area-inset-left,0px))] z-30 inline-flex size-14 items-center justify-center gap-2 rounded-full bg-brand font-bold text-white shadow-[0_8px_24px_-6px_rgba(11,85,72,0.55)] transition-transform hover:bg-brand-strong active:scale-95 sm:size-auto sm:min-h-12 sm:px-5">
        <MessageSquarePlus aria-hidden="true" className="size-6 sm:size-5" /><span className="hidden sm:inline">اكتب ملاحظة</span>
      </button>
      {/* فسحة آخر الصفحة على الهاتف: ليُمرَّر ما تحت الزر العائم إلى ما فوقه. */}
      <div aria-hidden="true" className="h-20 sm:hidden" />

      <Dialog open={open} wide title="ملاحظتك على النظام" onClose={() => { setOpen(false); setSaved(null); }}>
        <p className="text-muted">تُكتب الملاحظة على الشاشة التي أنت فيها: <strong className="text-ink">{screen}</strong>. اكتب ما رأيت، وما كنت تنتظر أن ترى.</p>
        <div role="group" aria-label="نوع الملاحظة" className="flex flex-wrap gap-2">
          {(Object.keys(KIND_AR) as Kind[]).map((k) => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{KIND_AR[k]}</Chip>)}
        </div>
        <Field label="الملاحظة">
          {(id) => <textarea id={id} rows={4} value={text} onChange={(e) => { setText(e.target.value); setSaved(null); }}
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/20"
            placeholder="مثال: في هذه الشاشة لا أجد بحثاً برقم الهاتف." />}
        </Field>
        <Field label="اسمك (اختياري)" hint="ليُعرف صاحب الملاحظة إن كثر المجرّبون.">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {saved === 'SHARED' && <Alert tone="ok">حُفظت ملاحظتك في السجل المشترك، ويراها صاحب النسخة.</Alert>}
        {saved === 'LOCAL' && !central && <Alert tone="ok">حُفظت ملاحظتك في متصفحك هذا. حين تفرغ من التجربة اضغط «انسخ ملاحظاتي» وأرسلها إلى صاحب النسخة.</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="me-auto text-sm text-muted">{central ? 'تُحفظ في السجل المشترك وفي متصفحك.' : 'تُحفظ في متصفحك، وتُرسلها أنت بنسخها.'}</span>
          <Button variant="secondary" onClick={() => { setOpen(false); setSaved(null); }}>إغلاق</Button>
          <Button disabled={text.trim().length < 3} onClick={save}>احفظ الملاحظة</Button>
        </div>

        {mine.length > 0 && (
          <section className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-bold">ملاحظاتك ({mine.length})</h3>
              <Button variant="secondary" className="ms-auto" onClick={copy}>{copied === 'YES' ? 'نُسخت' : 'انسخ ملاحظاتي'}</Button>
            </div>
            {copied === 'YES' && <p className="text-sm text-muted">نُسخت ملاحظاتك كلها. ألصقها في رسالة إلى صاحب النسخة.</p>}
            {copied === 'MANUAL' && <textarea ref={manual} readOnly rows={5} value={all()} aria-label="ملاحظاتك للنسخ" className="w-full rounded-lg border border-line-strong bg-ground p-3 text-sm" />}
            <ul className="flex flex-col gap-3">{mine.map((n) => <NoteRow key={n.id} n={n} onDelete={() => persist(mine.filter((x) => x.id !== n.id))} />)}</ul>
          </section>
        )}
        {shared.db && (
          <section className="flex flex-col gap-3 border-t border-line pt-4">
            <h3 className="font-bold">السجل المشترك{shared.notes ? ` (${shared.notes.length})` : ''}</h3>
            {shared.slow && <p className="text-sm text-muted">تعذّر بلوغ السجل المشترك الآن. ملاحظاتك محفوظة في متصفحك.</p>}
            {shared.notes?.length === 0 && <p className="text-sm text-muted">لا ملاحظات فيه بعد. أول ملاحظة يحفظها مجرّب مأذون له تظهر هنا للجميع.</p>}
            {!!shared.notes?.length && <ul className="flex flex-col gap-3">{shared.notes.map((n) => <NoteRow key={n.id} n={n} />)}</ul>}
          </section>
        )}
      </Dialog>
    </>
  );
}
