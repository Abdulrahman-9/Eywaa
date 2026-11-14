import { useSyncExternalStore } from 'react';
import { ApiError, api, setDevice } from './api';
import type { Manifest } from './offline';
import { vault, type Meta } from './vault';

export interface User { id: string; username: string; fullName: string; role: string }
export interface Station { campaignId: string; campaignName: string; unit: string; pointId: string; pointName: string; lane: number; lanes: number; loadedAt: string }
export interface Delivery {
  clientOpId: string; entitlementId: string; familyNo: string; headName: string; quantity: number; unit: string;
  deliveredAt: string; receiver: 'HEAD' | 'PROXY'; receiverName: string; mode: 'ONLINE' | 'OFFLINE';
  /** PENDING: لم يبلغ الخادم بعد. CONFLICT: الخادم وجده مسلَّماً قبلنا، ورُفع بلاغ. */
  sync: 'PENDING' | 'SYNCED' | 'CONFLICT' | 'UNKNOWN';
  photo: 'NONE' | 'PENDING' | 'SENT';
  conflict?: { first?: { at?: string; point?: string; receiverName?: string } };
}
export interface Registration {
  clientOpId: string; createdAt: string; headName: string; payload: Record<string, unknown>;
  sync: 'PENDING' | 'SYNCED' | 'REJECTED'; familyId?: string; familyNo?: string; status?: string; error?: string;
  /** صور الوثائق: تُرفع بعد أن يُعطي الخادم العائلة رقمها، ثم تُمحى من الجهاز. */
  photos: { key: string; category: 'IDENTITY' | 'RATION_CARD' | 'PAPER_FORM' | 'OTHER' }[];
}
/** زيارة إعادة تقييم مطلوبة من هذا الموظف، كما حُمّلت من الخادم. */
export interface Visit { id: string; familyNo: string; headName: string | null; phone: string | null; mahalla: string | null; landmark: string | null; reason: string; source: 'FAMILY' | 'STAFF' }
export interface VisitReport {
  clientOpId: string; reassessmentId: string; familyNo: string; headName: string | null; findings: string; outcome: 'NO_CHANGE' | 'CHANGED'; visitedAt: string;
  sync: 'PENDING' | 'SYNCED' | 'REJECTED'; error?: string;
}
/** حصة المتعهد في حملة جارية. */
export interface Assignment { campaignId: string; campaignName: string; unit: string; pointId: string; pointName: string; families: number; delivered: number; quantity: number }
/** تخويل سارٍ بالصرف لغير المسجَّلين، كما حُمّل من الخادم. */
export interface Grant { id: string; campaignId: string; campaignName: string; unit: string; maxCases: number; perCase: number; used: number; expiresAt: string; reason: string }
export interface GrantCase {
  clientOpId: string; grantId: string; headName: string; phone?: string; mahalla?: string; membersCount?: number; quantity: number; unit: string; deliveredAt: string;
  sync: 'PENDING' | 'SYNCED' | 'REJECTED'; error?: string; warnings?: string[];
}
/** صندوق تبرعات في عهدة المتعهد، كما حُمّل من الخادم. */
export interface Box { id: string; code: string; location: string; address: string | null; hostName: string | null; fund: string; lastOpenedAt: string | null; lastAmount: number | null; average: number; daysSince: number; stale: boolean; expectedNow: number | null }
export interface CustodyLine { id: string; no: string; kind: string; pending: boolean; description: string; party: string | null; at: string; fund: string; in: number; out: number; balance: number }
export interface GoodsTransfer { id: string; kind: string; inbound: boolean; item: string; unit: string; quantity: number; at: string; from: string | null; to: string | null; needsAck: boolean; ack: { ok: boolean; note: string | null } | null }
/** ما يخص المتعهد كما في الخادم عند آخر مزامنة: ذمته، صناديقه، وما آلت إليه طلباته. */
export interface AgentInfo {
  phone: string | null; at: string;
  custody: { balance: number; funds: { fundId: string; fund: string; balance: number }[]; lines: CustodyLine[] };
  goods: { warehouseId: string | null; balances: { itemId: string; item: string; unit: string; quantity: number }[]; transfers: GoodsTransfer[] };
  boxes: Box[];
  funds: { id: string; name: string; program: string | null }[];
  requests: {
    additions: { id: string; no: number; headName: string; status: string; at: string; familyNo: string | null; note: string | null }[];
    edits: { id: string; familyNo: string; reason: string; status: string; at: string; note: string | null }[];
  };
}
type OpSync = 'PENDING' | 'SYNCED' | 'REJECTED';
/** فتح صندوق تبرعات: ما عُدّ فيه يدخل ذمة المتعهد. */
export interface CollectionOp { clientOpId: string; boxId: string; code: string; location: string; amount: number; collectedAt: string; sealNo?: string; note?: string; sync: OpSync; error?: string; entryNo?: string; low?: boolean }
export interface DonationOp {
  clientOpId: string; kind: 'CASH' | 'IN_KIND'; donorName: string; donorPhone?: string; purpose?: string; reportedAt: string;
  amount?: number; fundId?: string; fundName?: string; itemText?: string; quantity?: number; unit?: string;
  sync: OpSync; error?: string; entryNo?: string; no?: number;
}
/** طلب إضافة عائلة (اسم وما تيسّر)، أو طلب تعديل عائلة برقمها. */
export interface RequestOp {
  clientOpId: string; kind: 'ADD' | 'EDIT'; createdAt: string; headName?: string; phone?: string; mahalla?: string; membersCount?: number; note?: string; familyNo?: string; reason?: string;
  sync: OpSync; error?: string; no?: number; already?: boolean;
}
/** شهادة المتعهد باستلام ما حُوّل إلى مخزنه، أو بفرق فيه. */
export interface AckOp { moveId: string; ok: boolean; note?: string; item: string; quantity: number; unit: string; sync: OpSync; error?: string }
/** كشف ميداني كُلّف به هذا الموظف، ومعه صورة العائلة كما في سجلها ليطابقها بما يرى. */
export interface InspectionTask {
  id: string; no: number; note: string | null; requestedAt: string; partner: string | null; late: boolean;
  family: {
    familyNo: string; headName: string | null; phone: string | null; mahalla: string | null; address: string; location: { lat: number; lng: number } | null;
    members: { name: string; relation: string; gender: string; age: number | null; isOrphan: boolean; disability: string | null; chronicIllness: string | null }[];
    facts: { key: string; label: string; recorded: string }[];
  };
}
export type Recommendation = 'CONFIRM' | 'RAISE' | 'LOWER' | 'REMOVE' | 'UNABLE';
/** ما آل إليه كشف رفعه: هل اعتُمد، وما أثره. */
export interface InspectionResult { id: string; no: number; familyNo: string; headName: string | null; recommendation: Recommendation; submittedAt: string; status: string; effect: string | null; points: number | null; decisionNote: string | null }
export interface InspectionOp {
  clientOpId: string; inspectionId: string; no: number; familyNo: string; headName: string | null; visitedAt: string;
  contact: 'FAMILY' | 'OTHERS' | 'NONE'; checks: { key: string; result: 'MATCH' | 'MISMATCH' | 'UNCHECKED'; found?: string }[]; notes?: string; recommendation: Recommendation; reason?: string;
  sync: OpSync; error?: string;
}
interface Data {
  token: string | null; user: User | null; station: Station | null; deliveries: Delivery[]; registrations: Registration[]; visits: Visit[]; visitReports: VisitReport[];
  assignments: Assignment[]; grants: Grant[]; cases: GrantCase[];
  agentInfo: AgentInfo | null; collections: CollectionOp[]; donations: DonationOp[]; requests: RequestOp[]; acks: AckOp[];
  inspections: InspectionTask[]; inspectionResults: InspectionResult[]; inspectionOps: InspectionOp[];
}

export interface AppState extends Data { meta: Meta | null; unlocked: boolean; manifest: Manifest | null; online: boolean; syncing: boolean; lastSync: string | null; needLogin: boolean; revoked: boolean }

const EMPTY: Data = { token: null, user: null, station: null, deliveries: [], registrations: [], visits: [], visitReports: [], assignments: [], grants: [], cases: [], agentInfo: null, collections: [], donations: [], requests: [], acks: [], inspections: [], inspectionResults: [], inspectionOps: [] };
const INSPECTORS = ['DISTRIBUTION_AGENT', 'FIELD_RESEARCHER'];
/** خطأ يردّ به الخادم العملية نفسها (لا انقطاع ولا جلسة منتهية ولا عطل): تُعلَّم مردودة ولا تُعاد. */
const rejected = (err: unknown): err is ApiError => err instanceof ApiError && !err.offline && err.status !== 401 && err.status < 500;
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
let state: AppState = { ...EMPTY, meta: null, unlocked: false, manifest: null, online: navigator.onLine, syncing: false, lastSync: null, needLogin: false, revoked: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<AppState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getState = () => state;
export const useApp = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getState);

/** يكتب البيانات إلى الخزنة. لا يُعدّ شيء محفوظاً حتى يعود هذا الوعد. */
async function save(patch: Partial<Data>) {
  const next: Data = { token: state.token, user: state.user, station: state.station, deliveries: state.deliveries, registrations: state.registrations, visits: state.visits, visitReports: state.visitReports, assignments: state.assignments, grants: state.grants, cases: state.cases, agentInfo: state.agentInfo, collections: state.collections, donations: state.donations, requests: state.requests, acks: state.acks,
    inspections: state.inspections, inspectionResults: state.inspectionResults, inspectionOps: state.inspectionOps, ...patch };
  await vault.put('data', next);
  set(next);
}

export const app = {
  async boot() {
    // يُطلب من المتصفح ألا يمحو مخزن التطبيق إن ضاق القرص: فيه تسليمات لم تُرفع.
    void navigator.storage?.persist?.().catch(() => false);
    const meta = (await vault.meta()) ?? null;
    setDevice(meta?.deviceId ?? null, () => void app.wipe(true));
    set({ meta });
  },

  /** الدخول يحتاج اتصالاً. يعيد المستخدم ورمز الجلسة دون أن يحفظ شيئاً: الحفظ بعد وضع رمز القفل. */
  async signIn(username: string, password: string, totp?: string) {
    const r = await api<{ token: string; user: User & { mustChangePassword: boolean } }>('/auth/login', { body: { username, password, ...(totp ? { code: totp } : {}) } });
    if (r.user.mustChangePassword) throw new ApiError(409, 'كلمة مرورك مؤقتة. غيّرها من لوحة الإدارة على الحاسوب أولاً، ثم ادخل هنا.');
    return r;
  },

  async setup(pin: string, session: { token: string; user: User }) {
    const meta = await vault.create(pin, { username: session.user.username, fullName: session.user.fullName });
    setDevice(meta.deviceId);
    set({ meta, unlocked: true, manifest: null, needLogin: false, revoked: false });
    await save({ ...EMPTY, token: session.token, user: session.user });
    await app.registerDevice();
  },

  async unlock(pin: string) {
    const r = await vault.unlock(pin);
    if (!r.ok) { set({ meta: (await vault.meta()) ?? null }); return r; }
    const data = { ...EMPTY, ...((await vault.get<Data>('data')) ?? {}) };
    set({ ...data, manifest: (await vault.get<Manifest>('manifest')) ?? null, unlocked: true, meta: (await vault.meta()) ?? null });
    return r;
  },

  lock() {
    vault.lock();
    set({ ...EMPTY, manifest: null, unlocked: false });
  },

  /** يمحو كل ما على الجهاز. revoked: المحو جاء بأمر الخادم لأن الجهاز سُحب. */
  async wipe(revoked = false) {
    await vault.wipe();
    setDevice(null);
    set({ ...EMPTY, meta: null, manifest: null, unlocked: false, needLogin: false, revoked });
  },

  /** يسجّل الجهاز في الخادم باسم موظفه ليظهر للمدير ويُسحب إن ضاع. إخفاقه لا يعطّل العمل؛ يُعاد عند كل مزامنة. */
  async registerDevice() {
    if (!state.meta || !state.token) return;
    const ua = /\(([^)]+)\)/.exec(navigator.userAgent)?.[1] ?? navigator.userAgent;
    await api('/devices', { token: state.token, body: { deviceId: state.meta.deviceId, label: ua.slice(0, 100) } }).catch(() => {});
  },

  /** تجديد الجلسة بعد انتهائها (12 ساعة) دون مسّ ما على الجهاز. */
  async relogin(password: string, totp?: string) {
    const r = await api<{ token: string; user: User }>('/auth/login', { body: { username: state.meta!.username, password, ...(totp ? { code: totp } : {}) } });
    await save({ token: r.token, user: r.user });
    set({ needLogin: false });
  },

  setOnline(online: boolean) { if (online !== state.online) set({ online }); },

  async loadStation(s: Omit<Station, 'loadedAt' | 'campaignName' | 'unit'>) {
    const manifest = await api<Manifest>(`/campaigns/${s.campaignId}/manifest?pointId=${s.pointId}&lane=${s.lane}&lanes=${s.lanes}`, { token: state.token, timeoutMs: 30_000 });
    await vault.put('manifest', manifest);
    set({ manifest });
    await save({ station: { ...s, campaignName: manifest.campaignName, unit: manifest.unit, loadedAt: new Date().toISOString() } });
  },

  async recordDelivery(d: Delivery) {
    await save({ deliveries: [...state.deliveries.filter((x) => x.clientOpId !== d.clientOpId), d] });
  },

  async attachPhoto(clientOpId: string, jpeg: Uint8Array) {
    await vault.putBytes(`photo:${clientOpId}`, jpeg);
    await save({ deliveries: state.deliveries.map((d) => (d.clientOpId === clientOpId ? { ...d, photo: 'PENDING' as const } : d)) });
  },

  async addRegistration(r: Registration, photos: Uint8Array[]) {
    for (const [i, bytes] of photos.entries()) await vault.putBytes(r.photos[i].key, bytes);
    await save({ registrations: [...state.registrations, r] });
  },
  async dropRegistration(clientOpId: string) {
    const r = state.registrations.find((x) => x.clientOpId === clientOpId);
    await save({ registrations: state.registrations.filter((x) => x.clientOpId !== clientOpId) });
    for (const p of r?.photos ?? []) await vault.delBytes(p.key);
  },

  async addCase(c: GrantCase) {
    await save({ cases: [...state.cases, c] });
  },
  async dropCase(clientOpId: string) {
    await save({ cases: state.cases.filter((c) => c.clientOpId !== clientOpId) });
  },

  async addCollection(c: CollectionOp) { await save({ collections: [...state.collections, c] }); },
  async addDonation(d: DonationOp) { await save({ donations: [...state.donations, d] }); },
  async addRequest(r: RequestOp) { await save({ requests: [...state.requests, r] }); },
  async addAck(a: AckOp) { await save({ acks: [...state.acks.filter((x) => x.moveId !== a.moveId), a] }); },
  async addInspection(op: InspectionOp) { await save({ inspectionOps: [...state.inspectionOps.filter((x) => x.inspectionId !== op.inspectionId), op] }); },
  /** يزيل عملية ردّها الخادم بعد أن رآها صاحبها. */
  async dropOp(list: 'collections' | 'donations' | 'requests' | 'inspectionOps', clientOpId: string) {
    if (list === 'inspectionOps') await save({ inspectionOps: state.inspectionOps.filter((x) => x.clientOpId !== clientOpId) });
    else if (list === 'collections') await save({ collections: state.collections.filter((x) => x.clientOpId !== clientOpId) });
    else if (list === 'donations') await save({ donations: state.donations.filter((x) => x.clientOpId !== clientOpId) });
    else await save({ requests: state.requests.filter((x) => x.clientOpId !== clientOpId) });
  },

  async addVisitReport(r: VisitReport) {
    await save({ visitReports: [...state.visitReports, r] });
  },
  async dropVisitReport(clientOpId: string) {
    await save({ visitReports: state.visitReports.filter((r) => r.clientOpId !== clientOpId) });
  },

  /**
   * المزامنة. كل عملية تحمل معرّفاً فريداً، فإعادة إرسالها لا تكرّرها في الخادم؛
   * ولا تُعلَّم عملية «وصلت» إلا بعد جواب الخادم عنها وحفظ ذلك في الخزنة.
   * فانقطاع الشبكة في أي لحظة لا يُفقد عملية ولا يكرّرها.
   */
  async sync(): Promise<{ ok: boolean; message: string }> {
    if (state.syncing || !state.unlocked || !state.token) return { ok: false, message: 'المزامنة جارية' };
    set({ syncing: true });
    try {
      const token = state.token;
      await app.registerDevice();
      if (!state.unlocked) return { ok: false, message: 'سُحب هذا الجهاز من النظام' };
      for (;;) {
        const batch = state.deliveries.filter((d) => d.sync === 'PENDING').slice(0, 200);
        if (!batch.length || !state.station) break;
        const res = await api<{ results: { clientOpId: string; result: 'APPLIED' | 'ALREADY_SYNCED' | 'CONFLICT' | 'UNKNOWN'; details?: Delivery['conflict'] }[] }>('/deliveries/sync', {
          token, timeoutMs: 30_000,
          body: { pointId: state.station.pointId, deviceId: state.meta!.deviceId, items: batch.map((d) => ({ entitlementId: d.entitlementId, deliveredAt: d.deliveredAt, clientOpId: d.clientOpId, receiver: d.receiver, receiverName: d.receiverName })) },
        });
        const by = new Map(res.results.map((r) => [r.clientOpId, r]));
        await save({
          deliveries: state.deliveries.map((d) => {
            const r = by.get(d.clientOpId);
            if (!r) return d;
            return r.result === 'CONFLICT' ? { ...d, sync: 'CONFLICT' as const, conflict: r.details } : r.result === 'UNKNOWN' ? { ...d, sync: 'UNKNOWN' as const } : { ...d, sync: 'SYNCED' as const };
          }),
        });
      }
      for (const d of state.deliveries.filter((x) => x.photo === 'PENDING' && (x.sync === 'SYNCED' || x.sync === 'CONFLICT'))) {
        const bytes = await vault.getBytes(`photo:${d.clientOpId}`);
        if (bytes) {
          const form = new FormData();
          form.append('file', new Blob([bytes as BlobPart], { type: 'image/jpeg' }), 'delivery.jpg');
          await api(`/deliveries/${d.entitlementId}/proof`, { form, token, timeoutMs: 60_000 });
        }
        await save({ deliveries: state.deliveries.map((x) => (x.clientOpId === d.clientOpId ? { ...x, photo: 'SENT' as const } : x)) });
        await vault.delBytes(`photo:${d.clientOpId}`);
      }
      for (const r of state.registrations.filter((x) => x.sync === 'PENDING')) {
        let patch: Partial<Registration>;
        try {
          const f = await api<{ id: string; familyNo: string; status: string }>('/families', { token, timeoutMs: 30_000, body: { ...r.payload, clientOpId: r.clientOpId } });
          patch = { sync: 'SYNCED', familyId: f.id, familyNo: f.familyNo, status: f.status, error: undefined };
        } catch (err) {
          if (!(err instanceof ApiError) || err.offline || err.status === 401 || err.status >= 500) throw err;
          const nos = [...new Set(((err.details?.conflicts ?? []) as { familyNo: string }[]).map((c) => c.familyNo))];
          patch = { sync: 'REJECTED', error: nos.length ? `مسجَّل سلفاً في العائلة ${nos.join('، ')}` : err.message };
        }
        await save({ registrations: state.registrations.map((x) => (x.clientOpId === r.clientOpId ? { ...x, ...patch } : x)) });
      }
      for (const r of state.registrations.filter((x) => x.sync === 'SYNCED' && x.photos.length > 0)) {
        for (const photo of r.photos) {
          const bytes = await vault.getBytes(photo.key);
          if (bytes) {
            const form = new FormData();
            form.append('category', photo.category);
            form.append('file', new Blob([bytes as BlobPart], { type: 'image/jpeg' }), 'photo.jpg');
            await api(`/families/${r.familyId}/attachments`, { form, token, timeoutMs: 60_000 });
          }
          await save({ registrations: state.registrations.map((x) => (x.clientOpId === r.clientOpId ? { ...x, photos: x.photos.filter((p) => p.key !== photo.key) } : x)) });
          await vault.delBytes(photo.key);
        }
      }
      for (const r of state.visitReports.filter((x) => x.sync === 'PENDING')) {
        let patch: Partial<VisitReport>;
        try {
          await api(`/reassessments/${r.reassessmentId}/visit`, { token, timeoutMs: 30_000, body: { findings: r.findings, outcome: r.outcome, visitedAt: r.visitedAt, clientOpId: r.clientOpId } });
          patch = { sync: 'SYNCED', error: undefined };
        } catch (err) {
          if (!(err instanceof ApiError) || err.offline || err.status === 401 || err.status >= 500) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ visitReports: state.visitReports.map((x) => (x.clientOpId === r.clientOpId ? { ...x, ...patch } : x)) });
      }
      for (const k of state.cases.filter((x) => x.sync === 'PENDING')) {
        let patch: Partial<GrantCase>;
        try {
          const r = await api<{ warnings: string[] }>(`/grants/${k.grantId}/cases`, { token, timeoutMs: 30_000, body: { headName: k.headName, phone: k.phone, mahalla: k.mahalla, membersCount: k.membersCount, deliveredAt: k.deliveredAt, clientOpId: k.clientOpId } });
          patch = { sync: 'SYNCED', warnings: r.warnings, error: undefined };
        } catch (err) {
          if (!(err instanceof ApiError) || err.offline || err.status === 401 || err.status >= 500) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ cases: state.cases.map((x) => (x.clientOpId === k.clientOpId ? { ...x, ...patch } : x)) });
      }
      for (const x of state.collections.filter((c) => c.sync === 'PENDING')) {
        let patch: Partial<CollectionOp>;
        try {
          const r = await api<{ entryNo: string | null; low: boolean }>(`/boxes/${x.boxId}/collections`, { token, timeoutMs: 30_000, body: { amount: x.amount, collectedAt: x.collectedAt, sealNo: x.sealNo, note: x.note, clientOpId: x.clientOpId } });
          patch = { sync: 'SYNCED', entryNo: r.entryNo ?? undefined, low: r.low, error: undefined };
        } catch (err) {
          if (!rejected(err)) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ collections: state.collections.map((c) => (c.clientOpId === x.clientOpId ? { ...c, ...patch } : c)) });
      }
      for (const x of state.donations.filter((d) => d.sync === 'PENDING')) {
        let patch: Partial<DonationOp>;
        try {
          const body = x.kind === 'CASH'
            ? { kind: 'CASH', amount: x.amount, fundId: x.fundId }
            : { kind: 'IN_KIND', itemText: x.itemText, quantity: x.quantity, unit: x.unit };
          const r = await api<{ no: number; entryNo: string | null }>('/agent-donations', { token, timeoutMs: 30_000, body: { ...body, donorName: x.donorName, donorPhone: x.donorPhone, purpose: x.purpose, reportedAt: x.reportedAt, clientOpId: x.clientOpId } });
          patch = { sync: 'SYNCED', no: r.no, entryNo: r.entryNo ?? undefined, error: undefined };
        } catch (err) {
          if (!rejected(err)) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ donations: state.donations.map((d) => (d.clientOpId === x.clientOpId ? { ...d, ...patch } : d)) });
      }
      for (const x of state.requests.filter((r) => r.sync === 'PENDING')) {
        let patch: Partial<RequestOp>;
        try {
          if (x.kind === 'ADD') {
            const r = await api<{ no: number }>('/quick-requests', { token, timeoutMs: 30_000, body: { headName: x.headName, phone: x.phone, mahalla: x.mahalla, membersCount: x.membersCount, note: x.note, clientOpId: x.clientOpId } });
            patch = { sync: 'SYNCED', no: r.no, error: undefined };
          } else {
            const r = await api<{ already: boolean }>('/agent/family-requests', { token, timeoutMs: 30_000, body: { familyNo: x.familyNo, reason: x.reason } });
            patch = { sync: 'SYNCED', already: r.already, error: undefined };
          }
        } catch (err) {
          if (!rejected(err)) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ requests: state.requests.map((r) => (r.clientOpId === x.clientOpId ? { ...r, ...patch } : r)) });
      }
      for (const x of state.acks.filter((a) => a.sync === 'PENDING')) {
        let patch: Partial<AckOp>;
        try {
          await api(`/agent/goods/${x.moveId}/ack`, { token, timeoutMs: 30_000, body: { ok: x.ok, note: x.note } });
          patch = { sync: 'SYNCED', error: undefined };
        } catch (err) {
          if (!rejected(err)) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ acks: state.acks.map((a) => (a.moveId === x.moveId ? { ...a, ...patch } : a)) });
      }
      for (const x of state.inspectionOps.filter((o) => o.sync === 'PENDING')) {
        let patch: Partial<InspectionOp>;
        try {
          await api(`/inspections/${x.inspectionId}/report`, { token, timeoutMs: 30_000, body: { contact: x.contact, checks: x.checks, notes: x.notes, recommendation: x.recommendation, reason: x.reason, visitedAt: x.visitedAt, clientOpId: x.clientOpId } });
          patch = { sync: 'SYNCED', error: undefined };
        } catch (err) {
          if (!rejected(err)) throw err;
          patch = { sync: 'REJECTED', error: err.message };
        }
        await save({ inspectionOps: state.inspectionOps.map((o) => (o.clientOpId === x.clientOpId ? { ...o, ...patch } : o)) });
      }
      if (state.user && INSPECTORS.includes(state.user.role)) {
        const mine = await api<{ pending: InspectionTask[]; recent: InspectionResult[] }>('/inspections/mine', { token, timeoutMs: 30_000 });
        // ما رُفع صار في جواب الخادم؛ وصورة العائلة تُمحى من الجهاز حين يخرج كشفها من المطلوب.
        await save({ inspections: mine.pending, inspectionResults: mine.recent, inspectionOps: state.inspectionOps.filter((o) => o.sync !== 'SYNCED') });
      }
      if (state.user?.role === 'DISTRIBUTION_AGENT') {
        const [assignments, grants, agentInfo] = await Promise.all([
          api<Assignment[]>('/agent/assignments', { token, timeoutMs: 30_000 }),
          api<Grant[]>('/agent/grants', { token, timeoutMs: 30_000 }),
          api<AgentInfo>('/agent/me', { token, timeoutMs: 30_000 }),
        ]);
        // ما وصل الخادم صار في كشفه؛ يبقى على الجهاز آخر ما رُفع ليراه صاحبه، وما لم يُرفع أو رُدّ.
        const keep = <T extends { sync: OpSync }>(list: T[]) => [...list.filter((x) => x.sync !== 'SYNCED'), ...list.filter((x) => x.sync === 'SYNCED').slice(-30)];
        await save({ assignments, grants, agentInfo, collections: keep(state.collections), donations: keep(state.donations), requests: keep(state.requests), acks: state.acks.filter((a) => a.sync !== 'SYNCED') });
      }
      if (state.user && REGISTRARS.includes(state.user.role)) {
        const visits = await api<Visit[]>('/reassessments?mine=true', { token, timeoutMs: 30_000 });
        await save({ visits: visits.map((v) => ({ id: v.id, familyNo: v.familyNo, headName: v.headName, phone: v.phone, mahalla: v.mahalla, landmark: v.landmark, reason: v.reason, source: v.source })) });
      }
      if (state.station) {
        try {
          const s = state.station;
          const manifest = await api<Manifest>(`/campaigns/${s.campaignId}/manifest?pointId=${s.pointId}&lane=${s.lane}&lanes=${s.lanes}`, { token, timeoutMs: 30_000 });
          await vault.put('manifest', manifest);
          set({ manifest });
        } catch (err) {
          // الحملة أُقفلت أو انتهت: يبقى البيان القديم للاطلاع، والتسليمات قد رُفعت.
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
        }
      }
      set({ lastSync: new Date().toISOString(), online: true });
      return { ok: true, message: 'تمّت المزامنة' };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DEVICE_REVOKED') return { ok: false, message: 'سُحب هذا الجهاز من النظام' };
      if (err instanceof ApiError && err.status === 401) { set({ needLogin: true }); return { ok: false, message: 'انتهت الجلسة. ادخل بكلمة مرورك لتُكمل المزامنة.' }; }
      if (err instanceof ApiError && err.offline) { set({ online: false }); return { ok: false, message: 'لا اتصال. ما على الجهاز محفوظ، ويُرفع حين يعود الاتصال.' }; }
      return { ok: false, message: err instanceof Error ? err.message : 'تعذّرت المزامنة' };
    } finally {
      set({ syncing: false });
    }
  },
};

export const pendingCount = (s: AppState) =>
  s.deliveries.filter((d) => d.sync === 'PENDING' || (d.photo === 'PENDING')).length + s.registrations.filter((r) => r.sync === 'PENDING' || (r.sync === 'SYNCED' && r.photos.length > 0)).length
  + s.visitReports.filter((r) => r.sync === 'PENDING').length + s.cases.filter((c) => c.sync === 'PENDING').length
  + [...s.collections, ...s.donations, ...s.requests, ...s.acks, ...s.inspectionOps].filter((x) => x.sync === 'PENDING').length;

/** عدد ما ردّه الخادم من عمليات المتعهد. */
export const rejectedOps = (s: AppState) => [...s.collections, ...s.donations, ...s.requests, ...s.inspectionOps].filter((x) => x.sync === 'REJECTED').length;

/** ما كُلّف به ولم يسجّل كشفه على هذا الهاتف بعد. */
export const inspectionsTodo = (s: AppState) => s.inspections.filter((t) => !s.inspectionOps.some((o) => o.inspectionId === t.id));

/** ذمة المتعهد النقدية كما يراها هاتفه: ما في دفتر الخادم عند آخر مزامنة، مع ما سجّله ولم يُرفع بعد. */
export function custodyOf(s: AppState) {
  const unsent = s.collections.filter((c) => c.sync === 'PENDING').reduce((n, c) => n + c.amount, 0) + s.donations.filter((d) => d.sync === 'PENDING' && d.kind === 'CASH').reduce((n, d) => n + (d.amount ?? 0), 0);
  return { book: s.agentInfo?.custody.balance ?? 0, unsent, total: (s.agentInfo?.custody.balance ?? 0) + unsent };
}
