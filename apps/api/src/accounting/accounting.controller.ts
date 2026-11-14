import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { AccountingService, closeSchema, custodySchema, fundSchema, paymentSchema, receiptSchema } from './accounting.service';

const BOOKS = ['ADMIN', 'ACCOUNTANT'] as const;
const READERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER', 'AUDITOR'] as const;
const noteSchema = z.object({ note: z.string().trim().min(1).optional() });
const listSchema = z.object({ status: z.enum(['POSTED', 'PENDING', 'REJECTED']).optional(), fundId: z.string().uuid().optional() });

@Controller('accounting')
export class AccountingController {
  constructor(@Inject(AccountingService) private readonly accounting: AccountingService) {}

  @Get('summary')
  @Roles(...READERS, 'PROJECT_SUPERVISOR')
  summary() {
    return this.accounting.summary();
  }

  @Post('funds')
  @Roles(...BOOKS)
  createFund(@Body(new ZodPipe(fundSchema)) body: z.infer<typeof fundSchema>, @CurrentUser() user: AuthUser) {
    return this.accounting.createFund(body, user);
  }

  @Get('entries')
  @Roles(...READERS)
  entries(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.accounting.entries(q);
  }

  @Post('receipts')
  @Roles(...BOOKS)
  receipt(@Body(new ZodPipe(receiptSchema)) body: z.infer<typeof receiptSchema>, @CurrentUser() user: AuthUser) {
    return this.accounting.receipt(body, user);
  }

  @Post('payments')
  @Roles(...BOOKS)
  payment(@Body(new ZodPipe(paymentSchema)) body: z.infer<typeof paymentSchema>, @CurrentUser() user: AuthUser) {
    return this.accounting.payment(body, user);
  }

  @Post('entries/:id/approve')
  @HttpCode(200)
  @Roles(...BOOKS)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.accounting.decide(id, true, body.note, user);
  }

  @Post('entries/:id/reject')
  @HttpCode(200)
  @Roles(...BOOKS)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.accounting.decide(id, false, body.note, user);
  }

  @Post('entries/:id/reverse')
  @Roles(...BOOKS)
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3) }))) body: { reason: string }, @CurrentUser() user: AuthUser) {
    return this.accounting.reverse(id, body.reason, user);
  }

  @Get('custody')
  @Roles(...READERS)
  custodies() {
    return this.accounting.custodies();
  }

  @Post('custody/issue')
  @Roles(...BOOKS)
  issue(@Body(new ZodPipe(custodySchema)) body: z.infer<typeof custodySchema>, @CurrentUser() user: AuthUser) {
    return this.accounting.issueCustody(body, user);
  }

  @Post('custody/close')
  @HttpCode(200)
  @Roles('ADMIN', 'ACCOUNTANT', 'DISTRIBUTOR', 'DISTRIBUTION_MANAGER')
  close(@Body(new ZodPipe(closeSchema)) body: z.infer<typeof closeSchema>, @CurrentUser() user: AuthUser) {
    return this.accounting.closeCustody(body, user);
  }

  @Get('trial-balance')
  @Roles(...READERS)
  trialBalance() {
    return this.accounting.trialBalance();
  }
}
