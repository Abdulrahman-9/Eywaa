import { randomBytes } from 'crypto';
import { canonical } from '../src/audit/audit.service';
import { normalizeDocNumber, normalizeIraqiPhone, normalizeName, toAsciiDigits } from '../src/common/arabic';
import { FieldCrypto, mask } from '../src/common/crypto';
import { formatFamilyNo, isValidFamilyNo } from '../src/common/family-no';

describe('توحيد الرسم العربي', () => {
  it('يوحّد الألف والتاء المربوطة والألف المقصورة ويحذف التشكيل', () => {
    expect(normalizeName('أَحْمَد إبراهيم فاطمة مصطفى')).toBe('احمد ابراهيم فاطمه مصطفي');
  });
  it('يضمّ «عبد» إلى ما بعدها فيستوي «عبد الله» و«عبدالله»', () => {
    expect(normalizeName('عبد الله عبد الرحمن')).toBe(normalizeName('عبدالله عبدالرحمن'));
  });
  it('يحوّل الأرقام الهندية', () => {
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDocNumber(' ١٩٨٦-٠٠١ / ٢ ')).toBe('19860012');
  });
  it('يوحّد صيغ الهاتف العراقي ويرفض الباطل', () => {
    for (const v of ['07701234567', '7701234567', '+9647701234567', '009647701234567', '٠٧٧٠١٢٣٤٥٦٧']) {
      expect(normalizeIraqiPhone(v)).toBe('07701234567');
    }
    expect(normalizeIraqiPhone('0660123456')).toBeNull();
    expect(normalizeIraqiPhone('077012345')).toBeNull();
  });
});

describe('رقم العائلة', () => {
  it('خانة التحقق تكشف خطأ الخانة الواحدة وتبديل المتجاورتين', () => {
    const no = formatFamilyNo(100123);
    expect(isValidFamilyNo(no)).toBe(true);
    for (let i = 0; i < no.length; i++) {
      const wrong = no.slice(0, i) + ((Number(no[i]) + 1) % 10) + no.slice(i + 1);
      expect(isValidFamilyNo(wrong)).toBe(false);
    }
    expect(isValidFamilyNo(formatFamilyNo(100132))).toBe(true);
    const swapped = no.slice(0, 4) + no[5] + no[4] + no.slice(6);
    expect(isValidFamilyNo(swapped)).toBe(false);
  });
});

describe('تشفير الحقول', () => {
  const crypto = new FieldCrypto(randomBytes(32).toString('base64'), randomBytes(32).toString('base64'));
  it('يشفّر ويفكّ، والنص المشفّر يختلف في كل مرة', () => {
    const a = crypto.encrypt('199012345678');
    expect(a).not.toBe(crypto.encrypt('199012345678'));
    expect(crypto.decrypt(a)).toBe('199012345678');
  });
  it('يرفض النص المشفّر إن عُبث به', () => {
    const raw = Buffer.from(crypto.encrypt('199012345678'), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => crypto.decrypt(raw.toString('base64'))).toThrow();
  });
  it('البصمة ثابتة للقيمة الواحدة', () => {
    expect(crypto.blindIndex('NC:1')).toBe(crypto.blindIndex('NC:1'));
    expect(crypto.blindIndex('NC:1')).not.toBe(crypto.blindIndex('NC:2'));
  });
  it('يُظهر آخر أربع خانات فقط', () => {
    expect(mask('199012345678')).toBe('********5678');
  });
});

describe('الصيغة القانونية لسجل التدقيق', () => {
  it('لا يغيّرها ترتيب المفاتيح', () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonical({ a: { c: null, d: [1, 2] }, b: 1 }));
  });
});
