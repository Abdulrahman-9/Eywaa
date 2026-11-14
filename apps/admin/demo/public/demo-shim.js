/*
 * نسخة العرض تعمل بلا خادم: كل طلب تبعثه اللوحة إلى ‎/api يُجاب هنا ممّا سُجّل من نظام حقيقي ببيانات وهمية (demo-data.js).
 * القراءة تُجاب بما سُجّل؛ والتغيير (حفظ، اعتماد، حذف) يُردّ برسالة تقول إن النسخة لا تحفظ.
 */
(() => {
  const D = window.__EYWAA_DEMO__;
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
  if (!D) return;
  const real = window.fetch.bind(window);
  const READ_ONLY = 'نسخة التجربة لا تحفظ التغييرات. جرّب الشاشات كما تشاء، ثم اكتب رأيك من زر «اكتب ملاحظة».';
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refuse = (message, status = 422) => json({ statusCode: status, message }, status);

  // تسوية العربية للبحث بالاسم، كما يسوّيها الخادم: بلا تشكيل، والألف والياء والتاء المربوطة بصورة واحدة.
  const norm = (s) => String(s ?? '').replace(/[ً-ْـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  const latin = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));

  /** قائمة العوائل تُصفّى هنا كما يصفّيها الخادم: بحث بالاسم أو الرقم أو الهاتف، وحال، وفئة، وحال الكشف، وصفحات. */
  function families(p) {
    let rows = D.families;
    const q = (p.get('q') ?? '').trim();
    if (q) {
      const digits = latin(q).replace(/\D/g, '');
      const numeric = digits.length > 0 && /^[\d٠-٩\s+]+$/.test(q);
      rows = numeric ? rows.filter((f) => f.familyNo.includes(digits) || (f.phone1 ?? '').includes(digits)) : rows.filter((f) => norm(f.headName).includes(norm(q)));
    }
    if (p.get('status')) rows = rows.filter((f) => f.status === p.get('status'));
    if (p.get('class')) rows = rows.filter((f) => f.score && f.score.class === p.get('class'));
    if (p.get('inspection')) rows = rows.filter((f) => f.inspection && f.inspection.state === p.get('inspection'));
    const offset = Number(p.get('offset') ?? 0) || 0, limit = Number(p.get('limit') ?? 50) || 50;
    return rows.slice(offset, offset + limit);
  }

  /** أقرب ما سُجّل لعنوان لم يُسجَّل بعينه: المسار نفسه بأكثر المعاملات تطابقاً. */
  function nearest(path, params) {
    let best, score = -1;
    for (const key of Object.keys(D.get)) {
      const [p, qs = ''] = key.split('?');
      if (p !== path) continue;
      const other = new URLSearchParams(qs);
      let s = 0;
      for (const [k, v] of params) if (other.get(k) === v) s += 2; else if (other.has(k)) s += 1;
      if (s > score) { score = s; best = key; }
    }
    return best;
  }

  function answer(method, u) {
    const path = u.pathname.replace(/^\/api/, '');
    if (method === 'GET') {
      if (path === '/auth/me') return json(D.me);
      if (path === '/families') return json(families(u.searchParams));
      if (/\.(csv|pdf|xlsx)$/.test(path) || path.startsWith('/files/')) return refuse('التنزيل وفتح المرفقات معطَّلان في نسخة التجربة.');
      const exact = D.get[path + u.search];
      if (exact !== undefined) return json(exact);
      const key = nearest(path, u.searchParams);
      if (key) return json(D.get[key]);
      return refuse('هذا السجل ليس في بيانات نسخة التجربة.', 404);
    }
    if (method === 'POST' && path === '/auth/login') return json({ token: 'demo', user: D.me });
    if (method === 'POST' && D.post[path] !== undefined) return json(D.post[path]);
    return refuse(READ_ONLY);
  }

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return real(input, init);
    const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    // مهلة قصيرة: لتظهر الشاشة كما تظهر مع خادم حقيقي، لا دفعة واحدة.
    return new Promise((resolve) => setTimeout(() => resolve(answer(method, u)), 90));
  };
})();
