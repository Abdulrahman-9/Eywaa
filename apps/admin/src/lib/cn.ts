import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** يجمع أصناف Tailwind ويحسم تعارضها: ما يُمرَّر من الخارج يغلب الافتراضي. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
