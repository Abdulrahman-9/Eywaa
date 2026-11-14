import { Injectable } from '@nestjs/common';

export type Channel = 'WHATSAPP' | 'SMS' | 'VOICE';
/** retry: عطل عابر (شبكة، ضغط على المزوّد) تُعاد بعده المحاولة؛ وبدونه الإخفاق نهائي لهذه القناة. */
export interface SendResult { ok: boolean; providerRef?: string; error?: string; retry?: boolean }

/** مزوّد قناة. ربط مزوّد حقيقي (واتساب للأعمال، رسائل نصية، مكالمات) يكون بتنفيذ هذه الواجهة. */
export interface ChannelDriver {
  readonly name: string;
  /** هل هو مزوّد حقيقي يوصل الرسالة إلى الهاتف؟ */
  readonly live: boolean;
  /** imageUrl: صورة تُرفق بالرسالة إن حملتها القناة (واتساب). الرسالة النصية والمكالمة تتجاهلانها. */
  send(channel: Channel, phone: string, text: string, imageUrl?: string): Promise<SendResult>;
}

/**
 * مزوّد المحاكاة: يسجّل الرسالة ولا يرسلها إلى أحد.
 * هو المستعمل حتى يُربط النظام بحساب واتساب للأعمال ومزوّد رسائل ومكالمات يعمل في العراق.
 */
export class SimulatedDriver implements ChannelDriver {
  readonly name = 'محاكاة';
  readonly live = false;
  private n = 0;

  async send(channel: Channel): Promise<SendResult> {
    return { ok: true, providerRef: `sim-${channel.toLowerCase()}-${++this.n}` };
  }
}

/**
 * مزوّد عبر بوّابة HTTP: يرسل كل رسالة طلباً إلى عنوان يُضبط في الإعداد.
 * الطلب:  POST <العنوان>  بترويسة Authorization: Bearer <الرمز>  وجسم {"channel","to","text"}، ومعها "imageUrl" في واتساب إن كان للرسالة صورة.
 * الجواب: 2xx وفيه {"id": "..."} نجاح؛ 429 أو 5xx أو انقطاع: عطل عابر يُعاد بعده؛ وغيرها إخفاق نهائي.
 * أكثر بوّابات الرسائل تقبل هذا الشكل أو يُكتب لها وسيط صغير يحوّله.
 */
export class HttpGatewayDriver implements ChannelDriver {
  readonly name: string;
  readonly live = true;

  constructor(private readonly url: string, private readonly token: string, private readonly channels: Channel[], private readonly timeoutMs = 15_000) {
    this.name = `بوّابة ${new URL(url).host}`;
  }

  async send(channel: Channel, phone: string, text: string, imageUrl?: string): Promise<SendResult> {
    if (!this.channels.includes(channel)) return { ok: false, error: 'القناة غير مفعَّلة عند المزوّد' };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ channel, to: phone, text, ...(imageUrl ? { imageUrl } : {}) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, retry: true, error: `تعذّر بلوغ المزوّد: ${(err as Error).message}` };
    }
    const data = (await res.json().catch(() => null)) as { id?: unknown; error?: unknown; message?: unknown } | null;
    if (res.ok) return { ok: true, providerRef: data?.id === undefined ? undefined : String(data.id) };
    const reason = String(data?.error ?? data?.message ?? `HTTP ${res.status}`).slice(0, 200);
    return { ok: false, retry: res.status === 429 || res.status >= 500, error: reason };
  }
}

/** يختار المزوّد من الإعداد: بوّابة حقيقية إن ضُبط عنوانها ورمزها، وإلا المحاكاة. */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelDriver {
  if (!env.MSG_GATEWAY_URL || !env.MSG_GATEWAY_TOKEN) return new SimulatedDriver();
  const channels = (env.MSG_GATEWAY_CHANNELS ?? 'SMS').split(',').map((c) => c.trim().toUpperCase()).filter((c): c is Channel => ['WHATSAPP', 'SMS', 'VOICE'].includes(c));
  return new HttpGatewayDriver(env.MSG_GATEWAY_URL, env.MSG_GATEWAY_TOKEN, channels);
}

/** حامل المزوّد الحالي، ليُستبدل دون تغيير بقية النظام. */
@Injectable()
export class Channels {
  private driver: ChannelDriver = driverFromEnv();

  get current(): ChannelDriver {
    return this.driver;
  }

  use(driver: ChannelDriver) {
    this.driver = driver;
  }
}

/** ترتيب القنوات لعائلة: واتساب ثم رسالة نصية؛ ومن لا يقرأ تصله مكالمة. */
export function chainFor(f: { hasWhatsapp: boolean; prefersVoice: boolean }): Channel[] {
  if (f.prefersVoice) return ['VOICE', 'SMS'];
  return f.hasWhatsapp ? ['WHATSAPP', 'SMS'] : ['SMS'];
}

/** يملأ المتغيرات «{الاسم}» ببيانات العائلة؛ والمجهول منها يبقى كما هو ليُرى الخطأ. */
export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
    const v = vars[key.trim()];
    return v === undefined || v === '' ? whole : String(v);
  });
}

export const VARIABLES = ['الاسم', 'رقم_العائلة', 'النقطة', 'مكان_الحضور', 'آخر_موعد', 'المقدار', 'الرمز_الرقمي'] as const;
/** متغيرات في النص لا يعرفها النظام. */
export function unknownVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) if (!(VARIABLES as readonly string[]).includes(m[1].trim())) out.add(m[1].trim());
  return [...out];
}
