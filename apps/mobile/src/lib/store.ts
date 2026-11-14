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
interface Data { token: string | null; user: User | null; station: Station | null; deliveries: Delivery[]; registrations: Registration[]; visits: Visit[]; visitReports: VisitReport[] }

export interface AppState extends Data { meta: Meta | null; unlocked: boolean; manifest: Manifest | null; online: boolean; syncing: boolean; lastSync: string | null; needLogin: boolean; revoked: boolean }

const EMPTY: Data = { token: null, user: null, station: null, deliveries: [], registrations: [], visits: [], visitReports: [] };
const REGISTRARS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'];
let state: AppState = { ...EMPTY, meta: null, unlocked: false, manifest: null, online: navigator.onLine, syncing: false, lastSync: null, needLogin: false, revoked: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<AppState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getState = () => state;
export const useApp = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getState);

/** يكتب البيانات إلى الخزنة. لا يُعدّ شيء محفوظاً حتى يعود هذا الوعد. */
async function save(patch: Partial<Data>) {
  const next: Data = { token: state.token, user: state.user, station: state.station, deliveries: state.deliveries, registrations: state.registrations, visits: state.visits, visitReports: state.visitReports, ...patch };
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
  + s.visitReports.filter((r) => r.sync === 'PENDING').length;
