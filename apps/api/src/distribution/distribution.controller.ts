import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { MAX_FILE_BYTES } from '../attachments/attachments.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import {
  CampaignInput, campaignSchema, CheckInput, checkSchema, DistributionService, RedeemInput, redeemSchema, SyncInput, syncSchema,
} from './distribution.service';

const MANAGERS = ['ADMIN', 'DISTRIBUTION_MANAGER'] as const;
const DESK = ['ADMIN', 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR'] as const;
const READERS = ['ADMIN', 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR', 'ACCOUNTANT', 'STOREKEEPER', 'AUDITOR'] as const;
const noteSchema = z.object({ note: z.string().trim().min(1).optional() });
const manifestSchema = z.object({ pointId: z.string().uuid(), lane: z.coerce.number().int().default(1), lanes: z.coerce.number().int().default(1) });

@Controller()
export class DistributionController {
  constructor(@Inject(DistributionService) private readonly dist: DistributionService) {}

  @Get('points')
  @Roles(...READERS)
  points() {
    return this.dist.points();
  }

  @Post('points')
  @Roles(...MANAGERS)
  createPoint(@Body(new ZodPipe(z.object({ name: z.string().trim().min(2).max(60) }))) body: { name: string }, @CurrentUser() user: AuthUser) {
    return this.dist.createPoint(body.name, user);
  }

  @Get('campaigns')
  @Roles(...READERS)
  list() {
    return this.dist.list();
  }

  @Post('campaigns')
  @Roles(...MANAGERS)
  create(@Body(new ZodPipe(campaignSchema)) body: CampaignInput, @CurrentUser() user: AuthUser) {
    return this.dist.create(body, user);
  }

  @Get('campaigns/:id')
  @Roles(...READERS)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.dist.detail(id);
  }

  @Post('campaigns/:id/submit')
  @HttpCode(200)
  @Roles(...MANAGERS)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.dist.submit(id, user);
  }

  @Post('campaigns/:id/approve')
  @HttpCode(200)
  @Roles(...MANAGERS)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.dist.decide(id, true, body.note, user);
  }

  @Post('campaigns/:id/reject')
  @HttpCode(200)
  @Roles(...MANAGERS)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.dist.decide(id, false, body.note, user);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  @Roles(...MANAGERS)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ note: z.string().trim().min(3) }))) body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.dist.cancel(id, body.note, user);
  }

  @Post('campaigns/:id/close')
  @HttpCode(200)
  @Roles(...MANAGERS)
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.dist.close(id, user);
  }

  @Get('campaigns/:id/tokens')
  @Roles(...MANAGERS)
  tokens(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.dist.tokens(id, user);
  }

  @Get('campaigns/:id/manifest')
  @Roles(...DESK)
  manifest(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(manifestSchema)) q: z.infer<typeof manifestSchema>) {
    return this.dist.manifest(id, q.pointId, q.lane, q.lanes);
  }

  @Post('deliveries/check')
  @HttpCode(200)
  @Roles(...DESK)
  check(@Body(new ZodPipe(checkSchema)) body: CheckInput, @CurrentUser() user: AuthUser) {
    return this.dist.check(body, user);
  }

  @Post('deliveries/redeem')
  @HttpCode(200)
  @Roles(...DESK)
  redeem(@Body(new ZodPipe(redeemSchema)) body: RedeemInput, @CurrentUser() user: AuthUser) {
    return this.dist.redeem(body, user);
  }

  @Post('deliveries/sync')
  @HttpCode(200)
  @Roles(...DESK)
  sync(@Body(new ZodPipe(syncSchema)) body: SyncInput, @CurrentUser() user: AuthUser) {
    return this.dist.sync(body, user);
  }

  @Post('deliveries/:id/proof')
  @Roles(...DESK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  proof(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @CurrentUser() user: AuthUser) {
    return this.dist.proof(id, file, user);
  }

  @Get('families/:id/deliveries')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'AUDITOR')
  familyDeliveries(@Param('id', ParseUUIDPipe) id: string) {
    return this.dist.familyDeliveries(id);
  }
}
