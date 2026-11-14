import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { QuickInput, QuickService, assignSchema, dismissSchema, inviteSchema, listQuickSchema, quickSchema } from './quick.service';

const FIELD = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER'] as const;
const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'] as const;

@Controller()
export class QuickController {
  constructor(@Inject(QuickService) private readonly quick: QuickService) {}

  @Get('quick-requests')
  @Roles(...FIELD, 'AUDITOR')
  list(@Query(new ZodPipe(listQuickSchema)) q: z.infer<typeof listQuickSchema>, @CurrentUser() user: AuthUser) {
    return this.quick.list(q, user);
  }

  @Post('quick-requests')
  @Roles(...FIELD, 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR')
  create(@Body(new ZodPipe(quickSchema)) body: QuickInput, @CurrentUser() user: AuthUser) {
    return this.quick.create(body, user);
  }

  @Get('quick-requests/:id')
  @Roles(...FIELD, 'AUDITOR')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.quick.get(id);
  }

  @Post('quick-requests/:id/invite')
  @HttpCode(200)
  @Roles(...DECIDERS)
  invite(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>, @CurrentUser() user: AuthUser) {
    return this.quick.invite(id, body.text, user);
  }

  @Post('quick-requests/:id/assign')
  @HttpCode(200)
  @Roles(...DECIDERS)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(assignSchema)) body: z.infer<typeof assignSchema>, @CurrentUser() user: AuthUser) {
    return this.quick.assign(id, body.userId, user);
  }

  @Post('quick-requests/:id/dismiss')
  @HttpCode(200)
  @Roles(...DECIDERS)
  dismiss(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(dismissSchema)) body: z.infer<typeof dismissSchema>, @CurrentUser() user: AuthUser) {
    return this.quick.dismiss(id, body.note, user);
  }
}
