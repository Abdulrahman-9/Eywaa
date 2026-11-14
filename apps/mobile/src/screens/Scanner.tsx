import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

declare const BarcodeDetector: undefined | (new (o: { formats: string[] }) => { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> });

/**
 * يقرأ رمز QR من الكاميرا الخلفية. يستعمل قارئ النظام إن وُجد (أسرع في الضوء الضعيف)،
 * وإلا قرأ الإطارات بنفسه. ينادي onResult مرة لكل رمز، ولا يكرّر الرمز نفسه في ثلاث ثوانٍ.
 */
export function Scanner({ onResult, paused }: { onResult: (text: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const handler = useRef(onResult);
  handler.current = onResult;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    let last = { text: '', at: 0 };
    const canvas = document.createElement('canvas');
    const detector = typeof BarcodeDetector !== 'undefined' ? new BarcodeDetector({ formats: ['qr_code'] }) : null;

    async function tick() {
      const v = video.current;
      if (stopped || !v) return;
      if (!pausedRef.current && v.readyState >= 2 && v.videoWidth) {
        let text = '';
        try {
          if (detector) text = (await detector.detect(v))[0]?.rawValue ?? '';
          else {
            // الرمز كثيف (نحو 330 حرفاً)، فلا يُصغَّر الإطار دون 960 نقطة.
            const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            text = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? '';
          }
        } catch { /* إطار لم يُقرأ: يُجرَّب الذي بعده */ }
        if (text && (text !== last.text || Date.now() - last.at > 3000)) {
          last = { text, at: Date.now() };
          navigator.vibrate?.(60);
          handler.current(text);
        }
      }
      timer = window.setTimeout(tick, 160);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current!.srcObject = stream;
        await video.current!.play().catch(() => {});
        void tick();
      } catch (err) {
        setError((err as Error)?.name === 'NotAllowedError' ? 'لم يُؤذن للتطبيق بالكاميرا. ائذن له من إعدادات المتصفح، أو اكتب رقم العائلة ورمزها.' : 'تعذّر فتح الكاميرا. اكتب رقم العائلة ورمزها.');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  if (error) return <div role="alert" className="rounded-xl bg-warn-soft px-4 py-3 font-semibold text-warn-ink">{error}</div>;
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-black">
      <video ref={video} muted playsInline aria-label="الكاميرا" className="size-full object-cover" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-[12%] rounded-xl border-4 border-white/80" />
    </div>
  );
}
