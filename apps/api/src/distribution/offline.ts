import { pbkdf2Sync } from 'crypto';
import { verifyToken } from './token';

/**
 * منطق جهاز التوزيع حين ينقطع الاتصال. دوالّ خالصة لا تمسّ الشبكة ولا القاعدة،
 * فتُنقل كما هي إلى تطبيق الجوال.
 *
 * القاعدة: المنع دون اتصال لا يصحّ إلا إذا كان لكل رمز جهة واحدة تملك قبوله.
 * فبيان الجهاز لا يحوي إلا استحقاقات نقطته وشبّاكه، وما ليس فيه لا يُقبل.
 */
export interface ManifestEntry {
  id: string;
  familyNo: string;
  headName: string;
  quantity: number;
  /** برهان الرمز الرقمي ليتحقق منه الجهاز وهو منقطع. null إن لم يكن للاستحقاق رمز رقمي. */
  codeCheck?: string | null;
  status: 'PENDING' | 'DELIVERED' | 'CANCELLED';
  receivers: { kind: 'HEAD' | 'PROXY'; name: string }[];
}
export interface Manifest {
  campaignId: string;
  pointId: string;
  lane: number;
  lanes: number;
  publicKey: string;
  endsAt: number;
  entries: ManifestEntry[];
}
export interface LocalDelivery {
  entitlementId: string; deliveredAt: string; receiver: 'HEAD' | 'PROXY'; receiverName: string; clientOpId: string;
  /** ما حضرت به العائلة: يُرفع مع التسليم ليتحقق منه الخادم، ثم يُمحى من الجهاز. */
  proof?: { token: string } | { code: string };
}

export type OfflineCheck =
  | { ok: true; entry: ManifestEntry }
  | { ok: false; reason: 'BAD_SIGNATURE' | 'OTHER_CAMPAIGN' | 'EXPIRED' | 'NOT_THIS_DEVICE' | 'ALREADY_DELIVERED' | 'CANCELLED' | 'BAD_CODE' };

/** هل يقبل هذا الجهاز هذا الرمز الآن، وهو بلا اتصال؟ */
export function checkOffline(token: string, manifest: Manifest, delivered: LocalDelivery[], nowSec: number): OfflineCheck {
  const payload = verifyToken(token, manifest.publicKey);
  if (!payload) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (payload.c !== manifest.campaignId) return { ok: false, reason: 'OTHER_CAMPAIGN' };
  if (nowSec > payload.x || nowSec > manifest.endsAt) return { ok: false, reason: 'EXPIRED' };
  const entry = manifest.entries.find((e) => e.id === payload.e);
  // ليس في بيان هذا الجهاز: هو لنقطة أخرى أو لشبّاك آخر، فصاحب قبوله غيرنا.
  if (!entry) return { ok: false, reason: 'NOT_THIS_DEVICE' };
  if (entry.status === 'CANCELLED') return { ok: false, reason: 'CANCELLED' };
  if (entry.status === 'DELIVERED' || delivered.some((d) => d.entitlementId === entry.id)) return { ok: false, reason: 'ALREADY_DELIVERED' };
  return { ok: true, entry };
}

/**
 * في أي شبّاك يقع الاستحقاق؟ (1 إلى lanes) بحسب ترتيبه بين استحقاقات نقطته،
 * فتتساوى الشبابيك مهما كان توزيع الأرقام على النقاط.
 */
export const laneOf = (indexInPoint: number, lanes: number) => (indexInPoint % lanes) + 1;

const CODE_ROUNDS = 1000;

/**
 * برهان الرمز الرقمي في بيان الجهاز: ستة عشر بتاً فقط من مشتقّ بطيء مملَّح بمعرّف الاستحقاق.
 * البتر مقصود. لو حُمل المشتقّ كاملاً لقدر من استخرج البيان من الجهاز أن يجرّب مئة مليون رمز فيعرف رمز كل عائلة.
 * وبالبتر يطابق كلَّ برهان نحو 1500 رمز، فلا يُعرف منه الرمز؛ ويبقى كافياً ليصدّ الجهاز من يخمّن عند الشبّاك
 * (يصيب تخمينه مرة من 65,536). والحكم الأخير للخادم: عند المزامنة يُطابَق الرمز نفسه ببصمته الكاملة.
 */
export function codeCheckFor(entitlementId: string, code: string): string {
  return pbkdf2Sync(code.replace(/\D/g, ''), entitlementId, CODE_ROUNDS, 2, 'sha256').toString('hex');
}

/** التحقق برقم العائلة والرمز الرقمي والجهاز منقطع. */
export function checkOfflineCode(familyNo: string, code: string, manifest: Manifest, delivered: LocalDelivery[], nowSec: number): OfflineCheck {
  if (nowSec > manifest.endsAt) return { ok: false, reason: 'EXPIRED' };
  const entry = manifest.entries.find((e) => e.familyNo === familyNo.trim());
  // رقم ليس في البيان ورمز خاطئ يُجابان بجواب واحد، فلا يُعرف منه أيّ الأرقام في هذا الشبّاك.
  if (!entry || !entry.codeCheck || entry.codeCheck !== codeCheckFor(entry.id, code)) return { ok: false, reason: 'BAD_CODE' };
  if (entry.status === 'CANCELLED') return { ok: false, reason: 'CANCELLED' };
  if (entry.status === 'DELIVERED' || delivered.some((d) => d.entitlementId === entry.id)) return { ok: false, reason: 'ALREADY_DELIVERED' };
  return { ok: true, entry };
}
