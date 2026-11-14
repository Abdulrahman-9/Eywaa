-- مفتاح الهوية الداخلي. رقم هوية الأحوال القديمة يتكرر بين السجلات، فالفرادة بالسجل والرقم معاً (بلا الصفحة)،
-- بعد توحيد كتابتهما. ومعه بصمة الرقم وحده، للمطابقة به حين يختلف السجل أو يُخطأ في كتابته.
-- البصمتان HMAC بمفتاح الخادم: لا تظهران في أي جواب، ولا يُستخرج منهما رقم.
alter table person_documents
  add column number_hash text,
  -- 1: المفتاح القديم (رقم|سجل|صفحة). 2: المفتاح الجديد. الخادم يعيد حساب القديم عند إقلاعه.
  add column key_version integer not null default 1;
create index person_documents_number on person_documents(number_hash) where number_hash is not null;
