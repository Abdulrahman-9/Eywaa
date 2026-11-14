import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ComposeInput, composeSchema, NotificationsService } from './notifications.service';

const SENDERS = ['ADMIN', 'DISTRIBUTION_MANAGER', 'BENEFICIARY_SUPERVISOR'] as const;
const noteSchema = z.object({ note: z.string().trim().min(1).optional() });
const statusSchema = z.object({ id: z.string().min(1).max(200), status: z.enum(['delivered', 'read', 'failed']), error: z.string().max(300).optional() });
const digest = (v: string) => createHash('sha256').update(v).digest();

@Controller()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @Roles(...SENDERS, 'AUDITOR')
  list() {
    return this.notifications.list();
  }

  /**
   * يناديه المزوّد حين تبلغ الرسالة الهاتف أو تُقرأ أو تخفق. لا جلسة له؛ إذنه سرّ مشترك في الترويسة.
   * إن لم يُضبط السرّ فالنقطة غير موجودة.
   */
  @Public()
  @Post('notifications/provider-status')
  @HttpCode(200)
  async providerStatus(@Headers('x-gateway-secret') secret: string | undefined, @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    const expected = process.env.MSG_CALLBACK_SECRET;
    if (!expected || !secret || !timingSafeEqual(digest(secret), digest(expected))) throw new NotFoundException();
    const known = await this.notifications.providerStatus(body.id, body.status.toUpperCase() as 'DELIVERED' | 'READ' | 'FAILED', body.error);
    return { ok: true, known };
  }

  @Get('notifications/driver')
  @Roles(...SENDERS, 'AUDITOR')
  driver() {
    return this.notifications.driver();
  }

  @Post('notifications/preview')
  @HttpCode(200)
  @Roles(...SENDERS)
  preview(@Body(new ZodPipe(composeSchema)) body: ComposeInput) {
    return this.notifications.preview(body);
  }

  @Post('notifications')
  @Roles(...SENDERS)
  compose(@Body(new ZodPipe(composeSchema)) body: ComposeInput, @CurrentUser() user: AuthUser) {
    return this.notifications.compose(body, user);
  }

  @Get('notifications/:id')
  @Roles(...SENDERS, 'AUDITOR')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.detail(id);
  }

  @Post('notifications/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'DISTRIBUTION_MANAGER')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.notifications.decide(id, true, body.note, user);
  }

  @Post('notifications/:id/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'DISTRIBUTION_MANAGER')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.notifications.decide(id, false, body.note, user);
  }

  @Get('families/:id/messages')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'DISTRIBUTION_MANAGER', 'AUDITOR')
  forFamily(@Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.forFamily(id);
  }
}
