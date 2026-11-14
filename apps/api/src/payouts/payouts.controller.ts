import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CreatePayoutInput, PayoutsService, approvePayoutSchema, createPayoutSchema, rejectPayoutSchema } from './payouts.service';

const MAKERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER'] as const;
const APPROVERS = ['ADMIN', 'ACCOUNTANT'] as const;
const READERS = ['ADMIN', 'ACCOUNTANT', 'DISTRIBUTION_MANAGER', 'AUDITOR'] as const;

@Controller()
export class PayoutsController {
  constructor(@Inject(PayoutsService) private readonly payouts: PayoutsService) {}

  @Get('campaigns/:id/payout-candidates')
  @Roles(...MAKERS)
  candidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.candidates(id);
  }

  @Get('campaigns/:id/payouts')
  @Roles(...READERS)
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.list(id);
  }

  @Post('payouts')
  @Roles(...MAKERS)
  create(@Body(new ZodPipe(createPayoutSchema)) body: CreatePayoutInput, @CurrentUser() user: AuthUser) {
    return this.payouts.create(body, user);
  }

  @Get('payouts/:id')
  @Roles(...READERS)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.get(id);
  }

  @Get('payouts/:id/file.csv')
  @Roles(...MAKERS)
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { name, csv } = await this.payouts.csv(id, user);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.csv`, 'Cache-Control': 'no-store' });
    res.end(csv);
  }

  @Post('payouts/:id/approve')
  @HttpCode(200)
  @Roles(...APPROVERS)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(approvePayoutSchema)) body: z.infer<typeof approvePayoutSchema>, @CurrentUser() user: AuthUser) {
    return this.payouts.approve(id, body.reference, user);
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  @Roles(...MAKERS)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rejectPayoutSchema)) body: z.infer<typeof rejectPayoutSchema>, @CurrentUser() user: AuthUser) {
    return this.payouts.reject(id, body.note, user);
  }
}
