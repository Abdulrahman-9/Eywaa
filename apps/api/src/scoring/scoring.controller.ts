import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';
import { AnyRole, AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ScoringService } from './scoring.service';

@Controller()
export class ScoringController {
  constructor(@Inject(ScoringService) private readonly scoring: ScoringService) {}

  @Get('scoring')
  @AnyRole()
  overview() {
    return this.scoring.overview();
  }

  @Post('scoring/simulate')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'AUDITOR')
  simulate(@Body() body: { criteria?: unknown; thresholds?: unknown }) {
    return this.scoring.simulate(body ?? {});
  }

  @Post('scoring/versions')
  @Roles('ADMIN')
  propose(@Body() body: { criteria?: unknown; thresholds?: unknown; note?: string }, @CurrentUser() user: AuthUser) {
    return this.scoring.propose(body ?? {}, user);
  }

  @Post('scoring/versions/:version/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  approve(@Param('version', ParseIntPipe) version: number, @Body() body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.scoring.decide(version, true, body?.note?.trim() || undefined, user);
  }

  @Post('scoring/versions/:version/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  reject(@Param('version', ParseIntPipe) version: number, @Body() body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.scoring.decide(version, false, body?.note?.trim() || undefined, user);
  }

  @Get('families/:id/score')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'AUDITOR')
  familyScore(@Param('id', ParseUUIDPipe) id: string) {
    return this.scoring.familyScore(id);
  }
}
