export const ROLES = [
  'ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER',
  'DISTRIBUTOR', 'STOREKEEPER', 'ACCOUNTANT', 'PROJECT_SUPERVISOR', 'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'مدير النظام',
  BENEFICIARY_SUPERVISOR: 'مشرف المستفيدين',
  FIELD_RESEARCHER: 'باحث ميداني',
  DISTRIBUTION_MANAGER: 'مدير التوزيع',
  DISTRIBUTOR: 'موظف توزيع',
  STOREKEEPER: 'أمين المخزن',
  ACCOUNTANT: 'محاسب',
  PROJECT_SUPERVISOR: 'مشرف المشاريع',
  AUDITOR: 'مدقق',
};

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: readonly Role[] | 'ALL';
  /** يعرض عدد ما ينتظر القرار. */
  badge?: boolean;
}

/** القائمة ومن يراها. الخادم هو الحكَم في الصلاحية؛ وهذه تُخفي ما لا يخصّ الدور. */
export const NAV: NavItem[] = [
  { to: '/', label: 'الرئيسية', roles: 'ALL', icon: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { to: '/families', label: 'العوائل', roles: ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'AUDITOR'], icon: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1a4 4 0 0 0-3-3.9M15.5 4.2a3.5 3.5 0 0 1 0 6.6' },
  { to: '/review', label: 'الاعتماد والشبهات', roles: ['ADMIN', 'BENEFICIARY_SUPERVISOR'], badge: true, icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8.5 12.5l2.5 2.5 4.5-5' },
  { to: '/scoring', label: 'النقاط والفئات', roles: ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'AUDITOR'], icon: 'M5 20V10M12 20V4M19 20v-7' },
  { to: '/programs', label: 'البرامج', roles: ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'], icon: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01' },
  { to: '/users', label: 'المستخدمون', roles: ['ADMIN'], icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1' },
  { to: '/audit', label: 'سجل التدقيق', roles: ['ADMIN', 'AUDITOR'], icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4' },
  { to: '/settings', label: 'الإعدادات', roles: 'ALL', icon: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4' },
];

export const canSee = (item: NavItem, role: Role) => item.roles === 'ALL' || item.roles.includes(role);
