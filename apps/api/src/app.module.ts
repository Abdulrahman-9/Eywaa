import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountingController } from './accounting/accounting.controller';
import { AccountingService } from './accounting/accounting.service';
import { AgentsController } from './agents/agents.controller';
import { AgentsService } from './agents/agents.service';
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
import { MonitorService } from './distribution/monitor.service';
import { DonorsService } from './donors/donors.service';
import { FamiliesController } from './families/families.controller';
import { FamiliesService } from './families/families.service';
import { GrantsController } from './grants/grants.controller';
import { GrantsService } from './grants/grants.service';
import { HousingController } from './housing/housing.controller';
import { HousingService } from './housing/housing.service';
import { InspectionsController } from './inspections/inspections.controller';
import { InspectionsService } from './inspections/inspections.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { Channels } from './notifications/channels';
import { MessageWorker } from './notifications/message.worker';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { PayoutsController } from './payouts/payouts.controller';
import { PayoutsService } from './payouts/payouts.service';
import { ProgramsController } from './programs/programs.controller';
import { ProgramsService } from './programs/programs.service';
import { QuickController } from './quick/quick.controller';
import { QuickService } from './quick/quick.service';
import { ReassessmentsController } from './reassessments/reassessments.controller';
import { ReassessmentsService } from './reassessments/reassessments.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { ScoringController } from './scoring/scoring.controller';
import { ScoringService } from './scoring/scoring.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StatsController } from './stats/stats.controller';
import { DevicesController } from './users/devices.controller';
import { UsersController } from './users/users.controller';

@Module({
  imports: [DbModule],
  controllers: [
    AuthController, UsersController, DevicesController, AuditController, SettingsController, StatsController,
    FamiliesController, AttachmentsController, ChangesController, ScoringController, ProgramsController, DistributionController, NotificationsController, InventoryController, AccountingController, HousingController, ReportsController, PayoutsController, ReassessmentsController, QuickController, GrantsController, AgentsController, InspectionsController,
  ],
  providers: [
    AuditService, SettingsService, ScoringService, FamiliesService, Storage, AttachmentsService, ChangesService, ProgramsService, Channels, NotificationsService, MessageWorker, InventoryService, AccountingService, DistributionService, MonitorService, HousingService, DonorsService, ReportsService, PayoutsService, ReassessmentsService, QuickService, GrantsService, AgentsService, InspectionsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
