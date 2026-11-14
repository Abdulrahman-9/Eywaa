import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AttachmentsController } from './attachments/attachments.controller';
import { AttachmentsService } from './attachments/attachments.service';
import { Storage } from './attachments/storage';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { ChangesController } from './changes/changes.controller';
import { ChangesService } from './changes/changes.service';
import { DbModule } from './db/db.module';
import { FamiliesController } from './families/families.controller';
import { FamiliesService } from './families/families.service';
import { ScoringController } from './scoring/scoring.controller';
import { ScoringService } from './scoring/scoring.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StatsController } from './stats/stats.controller';
import { UsersController } from './users/users.controller';

@Module({
  imports: [DbModule],
  controllers: [
    AuthController, UsersController, AuditController, SettingsController, StatsController,
    FamiliesController, AttachmentsController, ChangesController, ScoringController,
  ],
  providers: [
    AuditService, SettingsService, ScoringService, FamiliesService, Storage, AttachmentsService, ChangesService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
