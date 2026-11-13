import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuditService } from './audit.service';

@Controller('audit')
@Roles('ADMIN', 'AUDITOR')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('before') before?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.audit.list(n, before ? Number(before) : undefined);
  }

  @Get('verify')
  verify() {
    return this.audit.verify();
  }
}
