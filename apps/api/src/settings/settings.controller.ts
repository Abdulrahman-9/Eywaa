import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { AnyRole, AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ScoringService } from '../scoring/scoring.service';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
  ) {}

  @Get()
  @AnyRole()
  list() {
    return this.settings.list();
  }

  @Get(':key/history')
  @Roles('ADMIN', 'AUDITOR')
  history(@Param('key') key: string) {
    return this.settings.history(key);
  }

  @Put(':key')
  @Roles('ADMIN')
  async set(@Param('key') key: string, @Body() body: { value?: unknown }, @CurrentUser() user: AuthUser) {
    const result = await this.settings.set(key, body?.value, user);
    // خط الفقر يدخل في معيار الدخل، فتُعاد نقاط العوائل كلها.
    const recomputed = key === 'poverty_line_iqd' ? (await this.scoring.recomputeAll()).families : 0;
    return { ...result, recomputed };
  }
}
