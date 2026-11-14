import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import {
  AgentsService, BoxInput, BoxPatch, CollectionInput, DonationInput, ackSchema, boxPatchSchema, boxSchema, cancelDonationSchema, collectionSchema, donationSchema,
  familyRequestSchema, listDonationsSchema, receiveDonationSchema,
} from './agents.service';

/** من يتابع المتعهدين والصناديق. */
const WATCHERS = ['ADMIN', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'] as const;
const BOOKS = ['ADMIN', 'ACCOUNTANT'] as const;
const AGENT = 'DISTRIBUTION_AGENT' as const;

@Controller()
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  // ---------- متابعة المتعهدين ----------

  @Get('agents/overview')
  @Roles(...WATCHERS)
  overview() {
    return this.agents.overview();
  }

  @Get('agents/:id')
  @Roles(...WATCHERS)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.detail(id);
  }

  // ---------- ما يخص المتعهد نفسه ----------

  @Get('agent/me')
  @Roles(AGENT)
  mine(@CurrentUser() user: AuthUser) {
    return this.agents.mine(user);
  }

  @Post('agent/goods/:moveId/ack')
  @HttpCode(200)
  @Roles(AGENT)
  ack(@Param('moveId', ParseUUIDPipe) moveId: string, @Body(new ZodPipe(ackSchema)) body: z.infer<typeof ackSchema>, @CurrentUser() user: AuthUser) {
    return this.agents.ackGoods(moveId, body, user);
  }

  @Post('agent/family-requests')
  @Roles(AGENT)
  familyRequest(@Body(new ZodPipe(familyRequestSchema)) body: z.infer<typeof familyRequestSchema>, @CurrentUser() user: AuthUser) {
    return this.agents.familyRequest(body, user);
  }

  // ---------- صناديق التبرعات ----------

  @Get('boxes')
  @Roles(...WATCHERS)
  async boxes() {
    return { boxes: await this.agents.boxes(), summary: await this.agents.boxSummary() };
  }

  @Post('boxes')
  @Roles(...BOOKS)
  createBox(@Body(new ZodPipe(boxSchema)) body: BoxInput, @CurrentUser() user: AuthUser) {
    return this.agents.createBox(body, user);
  }

  @Get('boxes/:id')
  @Roles(...WATCHERS)
  box(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.box(id);
  }

  @Patch('boxes/:id')
  @Roles(...BOOKS)
  updateBox(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(boxPatchSchema)) body: BoxPatch, @CurrentUser() user: AuthUser) {
    return this.agents.updateBox(id, body, user);
  }

  @Post('boxes/:id/collections')
  @Roles(...BOOKS, AGENT)
  collect(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(collectionSchema)) body: CollectionInput, @CurrentUser() user: AuthUser) {
    return this.agents.collect(id, body, user);
  }

  // ---------- تبرعات بيد المتعهدين ----------

  @Get('agent-donations')
  @Roles(...WATCHERS, 'STOREKEEPER')
  donations(@Query(new ZodPipe(listDonationsSchema)) q: z.infer<typeof listDonationsSchema>) {
    return this.agents.donations(q);
  }

  @Post('agent-donations')
  @Roles(AGENT)
  donate(@Body(new ZodPipe(donationSchema)) body: DonationInput, @CurrentUser() user: AuthUser) {
    return this.agents.donate(body, user);
  }

  @Post('agent-donations/:id/receive')
  @HttpCode(200)
  @Roles('ADMIN', 'STOREKEEPER')
  receive(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(receiveDonationSchema)) body: z.infer<typeof receiveDonationSchema>, @CurrentUser() user: AuthUser) {
    return this.agents.receiveDonation(id, body, user);
  }

  @Post('agent-donations/:id/cancel')
  @HttpCode(200)
  @Roles('ADMIN', 'DISTRIBUTION_MANAGER', 'STOREKEEPER')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelDonationSchema)) body: z.infer<typeof cancelDonationSchema>, @CurrentUser() user: AuthUser) {
    return this.agents.cancelDonation(id, body.note, user);
  }
}
