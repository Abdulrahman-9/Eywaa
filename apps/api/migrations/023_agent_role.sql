-- دور المتعهد: يوزّع حصته من الحملة بتطبيق الميدان. في ملف وحده: القيمة الجديدة لا تُستعمل في معاملتها.
alter type user_role add value if not exists 'DISTRIBUTION_AGENT';
