/** خانة تحقق Luhn: تكشف خطأ الخانة الواحدة وتبديل خانتين متجاورتين. */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function formatFamilyNo(seq: number | string): string {
  const base = String(seq);
  return `${base}${luhnCheckDigit(base)}`;
}

export function isValidFamilyNo(value: string): boolean {
  if (!/^\d{2,}$/.test(value)) return false;
  return luhnCheckDigit(value.slice(0, -1)) === Number(value.slice(-1));
}
