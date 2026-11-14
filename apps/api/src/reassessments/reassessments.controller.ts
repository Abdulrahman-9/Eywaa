import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { OpenInput, ReassessmentsService, VisitInput, cancelSchema, closeSchema, openSchema, visitSchema } from './reassessments.service';

const FIELD = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'] as const;
const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'] as const;
const listSchema = z.object({
  familyId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'VISITED', 'CLOSED', 'CANCELLED']).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

@Controller()
export class ReassessmentsController {
  constructor(@Inject(ReassessmentsService) private readonly service: ReassessmentsService) {}

  @Get('reassessments')
  @Roles(...FIELD, 'AUDITOR')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>, @CurrentUser() user: AuthUser) {
    return this.service.list({ familyId: q.familyId, status: q.status, mine: q.mine === 'true' }, user);
  }

  /** من تُسند إليه الزيارة: الباحثون ومشرفو المستفيدين العاملون. */
  @Get('reassessments/assignees')
  @Roles(...FIELD)
  assignees() {
    return this.service.assignees();
  }

  @Post('reassessments')
  @Roles(...FIELD)
  open(@Body(new ZodPipe(openSchema)) body: OpenInput, @CurrentUser() user: AuthUser) {
    return this.service.open(body, user);
  }

  @Post('reassessments/:id/visit')
  @HttpCode(200)
  @Roles(...FIELD)
  visit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(visitSchema)) body: VisitInput, @CurrentUser() user: AuthUser) {
    return this.service.visit(id, body, user);
  }

  @Post('reassessments/:id/close')
  @HttpCode(200)
  @Roles(...DECIDERS)
  close(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(closeSchema)) body: z.infer<typeof closeSchema>, @CurrentUser() user: AuthUser) {
    return this.service.close(id, body.note, user);
  }

  @Post('reassessments/:id/cancel')
  @HttpCode(200)
  @Roles(...DECIDERS)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelSchema)) body: z.infer<typeof cancelSchema>, @CurrentUser() user: AuthUser) {
    return this.service.cancel(id, body.note, user);
  }
}
