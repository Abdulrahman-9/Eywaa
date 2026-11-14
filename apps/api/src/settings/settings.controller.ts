import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { AnyRole, AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

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
  set(@Param('key') key: string, @Body() body: { value?: unknown }, @CurrentUser() user: AuthUser) {
    return this.settings.set(key, body?.value, user);
  }
}
