-- كيف اختيرت عوائل الحملة (التصفية والترتيب والسقف واليدوي)، محفوظاً معها للرجوع إليه.
alter table campaigns add column selection jsonb not null default '{}';
-- صورة تُرفق بالرسالة في القنوات التي تحملها (رمز الاستلام في واتساب).
alter table messages add column media_url text;
