const TOKEN_KEY = 'eywaa.token';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const tokenStore = {
  // sessionStorage: الجلسة تنتهي بإغلاق التبويب، فلا تبقى مفتوحة على حاسوب مشترك.
  get: () => {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (t: string | null) => {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* يعمل بلا تخزين */ }
  },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'تعذّر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    const message = (data && typeof data.message === 'string' && data.message) || 'حدث خطأ غير متوقع';
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

/** رفع ملف (multipart). */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  } catch {
    throw new ApiError(0, 'تعذّر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const message = res.status === 413 ? 'حجم الملف يتجاوز 10 ميغابايت' : (data && typeof data.message === 'string' && data.message) || 'تعذّر رفع الملف';
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

/** ينزّل ملفاً يحتاج جلسة (كالتقارير): يُجلب بالرمز ثم يُحفظ من المتصفح. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const token = tokenStore.get();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, (data && typeof data.message === 'string' && data.message) || 'تعذّر تنزيل التقرير');
  }
  const header = res.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(header);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? decodeURIComponent(match[1]) : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // يُحرَّر الرابط بعد أن يبدأ المتصفح التنزيل، لا قبله.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
