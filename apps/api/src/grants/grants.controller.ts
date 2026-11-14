import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CaseInput, GrantInput, GrantsService, caseSchema, grantSchema, revokeSchema } from './grants.service';

const MANAGERS = ['ADMIN', 'DISTRIBUTION_MANAGER'] as const;

@Controller()
export class GrantsController {
  constructor(@Inject(GrantsService) private readonly grants: GrantsService) {}

  @Get('campaigns/:id/grants')
  @Roles(...MANAGERS, 'BENEFICIARY_SUPERVISOR', 'AUDITOR')
  forCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.grants.forCampaign(id);
  }

  @Post('campaigns/:id/grants')
  @Roles(...MANAGERS)
  create(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(grantSchema)) body: GrantInput, @CurrentUser() user: AuthUser) {
    return this.grants.create(id, body, user);
  }

  @Post('grants/:id/revoke')
  @HttpCode(200)
  @Roles(...MANAGERS)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(revokeSchema)) body: z.infer<typeof revokeSchema>, @CurrentUser() user: AuthUser) {
    return this.grants.revoke(id, body.note, user);
  }

  @Get('agent/grants')
  @Roles('DISTRIBUTION_AGENT')
  mine(@CurrentUser() user: AuthUser) {
    return this.grants.mine(user);
  }

  @Post('grants/:id/cases')
  @Roles('DISTRIBUTION_AGENT')
  addCase(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(caseSchema)) body: CaseInput, @CurrentUser() user: AuthUser) {
    return this.grants.addCase(id, body, user);
  }
}
