import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import {
  AssignInput, DecideInput, INSPECTOR_ROLES, InspectionsService, ReportInput, assignSchema, cancelSchema, candidatesSchema, decideSchema, listSchema, reportSchema,
} from './inspections.service';

/** من يكلّف بالكشف ويعتمده. */
const DECIDERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR'] as const;
const READERS = [...DECIDERS, 'DISTRIBUTION_MANAGER', 'AUDITOR'] as const;

@Controller()
export class InspectionsController {
  constructor(@Inject(InspectionsService) private readonly inspections: InspectionsService) {}

  @Get('inspections')
  @Roles(...READERS)
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.inspections.list(q);
  }

  @Get('inspections/summary')
  @Roles(...READERS)
  summary() {
    return this.inspections.summary();
  }

  @Get('inspections/inspectors')
  @Roles(...DECIDERS)
  inspectors() {
    return this.inspections.inspectors();
  }

  @Get('inspections/mine')
  @Roles(...INSPECTOR_ROLES)
  mine(@CurrentUser() user: AuthUser) {
    return this.inspections.mine(user);
  }

  @Post('inspections/candidates')
  @HttpCode(200)
  @Roles(...DECIDERS)
  candidates(@Body(new ZodPipe(candidatesSchema)) body: z.infer<typeof candidatesSchema>) {
    return this.inspections.candidates(body);
  }

  @Post('inspections')
  @Roles(...DECIDERS)
  assign(@Body(new ZodPipe(assignSchema)) body: AssignInput, @CurrentUser() user: AuthUser) {
    return this.inspections.assign(body, user);
  }

  @Get('inspections/:id')
  @Roles(...READERS)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.get(id);
  }

  @Post('inspections/:id/report')
  @HttpCode(200)
  @Roles(...INSPECTOR_ROLES)
  report(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reportSchema)) body: ReportInput, @CurrentUser() user: AuthUser) {
    return this.inspections.report(id, body, user);
  }

  @Post('inspections/:id/decide')
  @HttpCode(200)
  @Roles(...DECIDERS)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideSchema)) body: DecideInput, @CurrentUser() user: AuthUser) {
    return this.inspections.decide(id, body, user);
  }

  @Post('inspections/:id/cancel')
  @HttpCode(200)
  @Roles(...DECIDERS)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelSchema)) body: z.infer<typeof cancelSchema>, @CurrentUser() user: AuthUser) {
    return this.inspections.cancel(id, body.note, user);
  }
}
