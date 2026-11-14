import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CHANGE_TYPES, ChangesService } from './changes.service';

const requestSchema = z.object({
  type: z.enum(CHANGE_TYPES),
  payload: z.unknown(),
  reason: z.string().trim().min(3, 'يلزم ذكر سبب التعديل'),
});
const listSchema = z.object({
  familyId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});
const decisionSchema = z.object({ note: z.string().trim().min(1).optional() });

@Controller()
export class ChangesController {
  constructor(@Inject(ChangesService) private readonly changes: ChangesService) {}

  @Post('families/:id/changes')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER')
  request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(requestSchema)) body: z.infer<typeof requestSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.changes.request(id, body.type, body.payload, body.reason, user);
  }

  @Get('changes')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'AUDITOR')
  list(@Query(new ZodPipe(listSchema)) query: z.infer<typeof listSchema>) {
    return this.changes.list(query);
  }

  @Post('changes/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.changes.decide(id, true, body.note, user);
  }

  @Post('changes/:id/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.changes.decide(id, false, body.note, user);
  }
}
