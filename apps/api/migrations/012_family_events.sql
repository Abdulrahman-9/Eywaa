-- حدثان في حياة العائلة: تغيير رب الأسرة (وفاة، سفر، انفصال)، ونقل فرد إلى عائلة أخرى (زواج، كفالة).
-- كلاهما طلب تعديل يعتمده موظف آخر.
alter type change_type add value if not exists 'CHANGE_HEAD';
alter type change_type add value if not exists 'TRANSFER_MEMBER';
