-- حدّ محاولات الدخول، وتغيير كلمة المرور، والتحقق بعاملين.
alter table users add column failed_logins integer not null default 0;
alter table users add column locked_until timestamptz;
alter table users add column must_change_password boolean not null default false;
alter table users add column password_changed_at timestamptz;
alter table users add column totp_secret_enc text;          -- سرّ التحقق بعاملين، مشفّراً
alter table users add column totp_enabled boolean not null default false;
alter table users add column totp_last_step bigint;         -- آخر رمز استُعمل، فلا يُعاد استعماله
