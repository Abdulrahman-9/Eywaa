import { Injectable } from '@nestjs/common';

export type Channel = 'WHATSAPP' | 'SMS' | 'VOICE';
export interface SendResult { ok: boolean; providerRef?: string; error?: string }

/** مزوّد قناة. ربط مزوّد حقيقي (واتساب للأعمال، رسائل نصية، مكالمات) يكون بتنفيذ هذه الواجهة. */
export interface ChannelDriver {
  readonly name: string;
  /** هل هو مزوّد حقيقي يوصل الرسالة إلى الهاتف؟ */
  readonly live: boolean;
  send(channel: Channel, phone: string, text: string): Promise<SendResult>;
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

/** حامل المزوّد الحالي، ليُستبدل دون تغيير بقية النظام. */
@Injectable()
export class Channels {
  private driver: ChannelDriver = new SimulatedDriver();

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

export const VARIABLES = ['الاسم', 'رقم_العائلة', 'النقطة', 'آخر_موعد', 'المقدار', 'الرمز_الرقمي'] as const;
/** متغيرات في النص لا يعرفها النظام. */
export function unknownVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) if (!(VARIABLES as readonly string[]).includes(m[1].trim())) out.add(m[1].trim());
  return [...out];
}
