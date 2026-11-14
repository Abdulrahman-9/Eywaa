import { ed25519 } from '@noble/curves/ed25519';

/**
 * منطق الجهاز حين ينقطع الاتصال. هو نفسه ما في الخادم (apps/api/src/distribution/offline.ts)،
 * منقولاً إلى المتصفح: التوقيع يُتحقَّق منه بالمفتاح العام، فلا يحتاج الجهاز سرّاً.
 *
 * القاعدة: المنع دون اتصال لا يصحّ إلا إذا كان لكل رمز جهة واحدة تملك قبوله.
 * فبيان الجهاز لا يحوي إلا استحقاقات نقطته وشبّاكه، وما ليس فيه لا يُقبل.
 */
export interface ManifestEntry {
  id: string; familyNo: string; headName: string; quantity: number; codeCheck?: string | null;
  status: 'PENDING' | 'DELIVERED' | 'CANCELLED';
  receivers: { kind: 'HEAD' | 'PROXY'; name: string }[];
}
export interface Manifest {
  campaignId: string; campaignName: string; unit: string; pointId: string; lane: number; lanes: number;
  publicKey: string; endsAt: number; entries: ManifestEntry[];
}
export type Reason = 'BAD_SIGNATURE' | 'OTHER_CAMPAIGN' | 'EXPIRED' | 'NOT_THIS_DEVICE' | 'ALREADY_DELIVERED' | 'CANCELLED' | 'BAD_CODE';
export type OfflineCheck = { ok: true; entry: ManifestEntry } | { ok: false; reason: Reason };

const bytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

interface TokenPayload { e: string; c: string; p: string; f: string; q: number; x: number }

export function verifyToken(token: string, publicKeyB64: string): TokenPayload | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'E1') return null;
  try {
    if (!ed25519.verify(bytes(parts[2]), new TextEncoder().encode(`E1.${parts[1]}`), bytes(publicKeyB64))) return null;
    const p = JSON.parse(new TextDecoder().decode(bytes(parts[1])));
    if (typeof p.e !== 'string' || typeof p.c !== 'string' || typeof p.f !== 'string' || !Number.isInteger(p.q) || !Number.isInteger(p.x)) return null;
    return p as TokenPayload;
  } catch {
    return null;
  }
}

function settle(entry: ManifestEntry | undefined, deliveredIds: Set<string>, missing: Reason): OfflineCheck {
  if (!entry) return { ok: false, reason: missing };
  if (entry.status === 'CANCELLED') return { ok: false, reason: 'CANCELLED' };
  if (entry.status === 'DELIVERED' || deliveredIds.has(entry.id)) return { ok: false, reason: 'ALREADY_DELIVERED' };
  return { ok: true, entry };
}

/** هل يقبل هذا الجهاز هذا الرمز المصوَّر الآن، وهو بلا اتصال؟ */
export function checkOffline(token: string, manifest: Manifest, deliveredIds: Set<string>, nowSec: number): OfflineCheck {
  const payload = verifyToken(token, manifest.publicKey);
  if (!payload) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (payload.c !== manifest.campaignId) return { ok: false, reason: 'OTHER_CAMPAIGN' };
  if (nowSec > payload.x || nowSec > manifest.endsAt) return { ok: false, reason: 'EXPIRED' };
  // ليس في بيان هذا الجهاز: هو لنقطة أخرى أو لشبّاك آخر، فصاحب قبوله غيرنا.
  return settle(manifest.entries.find((e) => e.id === payload.e), deliveredIds, 'NOT_THIS_DEVICE');
}

async function codeCheckFor(entitlementId: string, code: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(code.replace(/\D/g, '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(entitlementId), iterations: 1000, hash: 'SHA-256' }, base, 128);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/** التحقق برقم العائلة ورمزها الرقمي والجهاز منقطع. الرقم الذي ليس في البيان والرمز الخاطئ بجواب واحد. */
export async function checkOfflineCode(familyNo: string, code: string, manifest: Manifest, deliveredIds: Set<string>, nowSec: number): Promise<OfflineCheck> {
  if (nowSec > manifest.endsAt) return { ok: false, reason: 'EXPIRED' };
  const entry = manifest.entries.find((e) => e.familyNo === familyNo.trim());
  if (!entry || !entry.codeCheck || entry.codeCheck !== (await codeCheckFor(entry.id, code))) return { ok: false, reason: 'BAD_CODE' };
  return settle(entry, deliveredIds, 'BAD_CODE');
}

export const REASON_TEXT: Record<Reason, { title: string; advice: string }> = {
  ALREADY_DELIVERED: { title: 'هذا الرمز استُعمل من قبل', advice: 'أرِ صاحبه ذلك. إن أنكر فأحِله إلى المشرف.' },
  BAD_SIGNATURE: { title: 'رمز غير صحيح أو مزوَّر', advice: 'ليس من إصدار النظام. أبلغ المشرف.' },
  BAD_CODE: { title: 'رقم العائلة أو الرمز الرقمي غير صحيح', advice: 'أعد الإدخال. والجهاز منقطع: لا يُقبل إلا من كان في حصة هذا الشبّاك.' },
  OTHER_CAMPAIGN: { title: 'الرمز لحملة أخرى', advice: 'تأكد من الحملة المختارة في الجهاز.' },
  EXPIRED: { title: 'انتهت مدة الحملة', advice: 'أحِله إلى المشرف.' },
  NOT_THIS_DEVICE: { title: 'ليس من حصة هذا الجهاز', advice: 'الجهاز منقطع، وهذه العائلة لشبّاك آخر أو نقطة أخرى. وجّهها إليه، أو انتظر عودة الاتصال.' },
  CANCELLED: { title: 'أُلغي هذا الاستحقاق', advice: 'أحِله إلى المشرف.' },
};
