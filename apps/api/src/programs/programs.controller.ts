import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ProgramInput, programSchema, ProgramsService } from './programs.service';

const READERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'] as const;

@Controller()
export class ProgramsController {
  constructor(@Inject(ProgramsService) private readonly programs: ProgramsService) {}

  @Get('programs')
  @Roles(...READERS)
  list() {
    return this.programs.list();
  }

  @Post('programs')
  @Roles('ADMIN')
  create(@Body(new ZodPipe(programSchema)) body: ProgramInput, @CurrentUser() user: AuthUser) {
    return this.programs.create(body, user);
  }

  @Post('programs/preview')
  @HttpCode(200)
  @Roles('ADMIN', 'DISTRIBUTION_MANAGER')
  preview(@Body() body: unknown) {
    return this.programs.preview(body);
  }

  @Put('programs/:id')
  @Roles('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(programSchema)) body: ProgramInput, @CurrentUser() user: AuthUser) {
    return this.programs.update(id, body, user);
  }

  @Get('programs/:id/eligible')
  @Roles(...READERS)
  eligible(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.programs.eligibleFor(id, Math.min(Math.max(Number(limit) || 50, 1), 500));
  }

  @Get('families/:id/entitlements')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'AUDITOR')
  forFamily(@Param('id', ParseUUIDPipe) id: string) {
    return this.programs.forFamily(id);
  }
}
