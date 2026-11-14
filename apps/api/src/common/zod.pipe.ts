import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    // طلب بلا جسم يُعامَل كجسم فارغ: يصحّ إن كانت الحقول كلها اختيارية، وإلا ذُكر الناقص منها باسمه.
    const result = this.schema.safeParse(value === undefined ? {} : value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'بيانات غير صالحة',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
