import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { DbModule } from './db/db.module';
import { FamiliesController } from './families/families.controller';
import { FamiliesService } from './families/families.service';
import { UsersController } from './users/users.controller';

@Module({
  imports: [DbModule],
  controllers: [AuthController, UsersController, AuditController, FamiliesController],
  providers: [AuditService, FamiliesService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
