/** يصغّر الصورة ويضغطها قبل حفظها: شبكة ضعيفة وتخزين محدود. الناتج نحو 150–300 ك.ب. */
export async function compress(file: Blob, maxSide = 1600, quality = 0.7): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('encode'))), 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}
