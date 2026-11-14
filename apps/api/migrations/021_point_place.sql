-- مكان الحضور: عنوان النقطة وساعات عملها، ليُكتبا في دعوة الاستلام.
alter table distribution_points add column address text, add column hours text;
