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
import { DistributionController } from './distribution/distribution.controller';
import { DistributionService } from './distribution/distribution.service';
import { FamiliesController } from './families/families.controller';
import { FamiliesService } from './families/families.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { Channels } from './notifications/channels';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { ProgramsController } from './programs/programs.controller';
import { ProgramsService } from './programs/programs.service';
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
    FamiliesController, AttachmentsController, ChangesController, ScoringController, ProgramsController, DistributionController, NotificationsController, InventoryController,
  ],
  providers: [
    AuditService, SettingsService, ScoringService, FamiliesService, Storage, AttachmentsService, ChangesService, ProgramsService, Channels, NotificationsService, InventoryService, DistributionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
