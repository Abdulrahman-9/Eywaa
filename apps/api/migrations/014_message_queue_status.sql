-- حال «في الطابور» للرسالة. في ملف وحده: القيمة الجديدة لا تُستعمل في المعاملة التي أضافتها.
alter type message_status add value if not exists 'QUEUED';
