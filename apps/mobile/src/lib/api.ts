export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) {
    super(message);
  }
  /** الخادم لم يُبلَغ أو لم يُجب: لا يُعرف هل نُفّذ الطلب. */
  get offline() { return this.status === 0; }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; token?: string | null; timeoutMs?: number } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: ctl.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'لا اتصال بالخادم');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  // بوّابة أو شبكة أسيرة تجيب بغير ما يجيب به الخادم: تُعامل كانقطاع.
  if (res.status >= 502 && res.status <= 504) throw new ApiError(0, 'لا اتصال بالخادم');
  if (!res.ok) throw new ApiError(res.status, (data && typeof data.message === 'string' && data.message) || 'حدث خطأ غير متوقع', data?.code, data?.details ?? data);
  return data as T;
}
