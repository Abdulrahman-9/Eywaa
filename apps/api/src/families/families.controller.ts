import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import {
  CreateFamilyInput, DocumentInput, createFamilySchema, decisionSchema, documentSchema, resolveFlagSchema,
} from './families.schema';
import { FamiliesService } from './families.service';

const STATUSES = ['PENDING_DEDUPE_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().optional(),
  class: z.enum(['A', 'B', 'C', 'D']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller()
export class FamiliesController {
  constructor(@Inject(FamiliesService) private readonly families: FamiliesService) {}

  @Post('families')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER')
  create(@Body(new ZodPipe(createFamilySchema)) body: CreateFamilyInput, @CurrentUser() user: AuthUser) {
    return this.families.create(body, user);
  }

  @Get('families')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'PROJECT_SUPERVISOR', 'AUDITOR')
  list(@Query(new ZodPipe(listSchema)) query: z.infer<typeof listSchema>) {
    return this.families.list(query);
  }

  @Post('families/lookup/document')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER')
  lookupDocument(@Body(new ZodPipe(documentSchema)) body: DocumentInput) {
    return this.families.lookupDocument(body);
  }

  @Post('families/lookup/ration-card')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER')
  lookupRation(@Body(new ZodPipe(z.object({ number: z.string().min(1) }))) body: { number: string }) {
    return this.families.lookupRationCard(body.number);
  }

  @Get('families/:id')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'PROJECT_SUPERVISOR', 'AUDITOR')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.families.get(id);
  }

  @Post('families/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.families.decide(id, 'APPROVED', body.note, user);
  }

  @Post('families/:id/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.families.decide(id, 'REJECTED', body.note, user);
  }

  @Get('duplicate-flags')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'AUDITOR')
  flags() {
    return this.families.listOpenFlags();
  }

  @Post('duplicate-flags/:id/resolve')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveFlagSchema)) body: z.infer<typeof resolveFlagSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.families.resolveFlag(id, body.decision, body.note, user);
  }
}
