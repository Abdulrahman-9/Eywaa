import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { MAX_FILE_BYTES } from '../attachments/attachments.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { contractorSchema, HousingService, ProjectInput, projectSchema } from './housing.service';

const SUPERVISORS = ['ADMIN', 'PROJECT_SUPERVISOR'] as const;
const READERS = ['ADMIN', 'PROJECT_SUPERVISOR', 'ACCOUNTANT', 'AUDITOR'] as const;
const note = z.object({ note: z.string().trim().min(3, 'يلزم ذكر ما رأيت أو ما طُلب') });

@Controller('housing')
export class HousingController {
  constructor(@Inject(HousingService) private readonly housing: HousingService) {}

  @Get('contractors')
  @Roles(...READERS)
  contractors() {
    return this.housing.contractors();
  }

  @Post('contractors')
  @Roles(...SUPERVISORS)
  createContractor(@Body(new ZodPipe(contractorSchema)) body: z.infer<typeof contractorSchema>, @CurrentUser() user: AuthUser) {
    return this.housing.createContractor(body, user);
  }

  @Get('projects')
  @Roles(...READERS)
  list() {
    return this.housing.list();
  }

  @Post('projects')
  @Roles(...SUPERVISORS)
  create(@Body(new ZodPipe(projectSchema)) body: ProjectInput, @CurrentUser() user: AuthUser) {
    return this.housing.create(body, user);
  }

  @Get('projects/:id')
  @Roles(...READERS)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.housing.detail(id);
  }

  @Post('projects/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'PROJECT_SUPERVISOR', 'ACCOUNTANT')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.housing.decide(id, true, undefined, user);
  }

  @Post('projects/:id/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'PROJECT_SUPERVISOR', 'ACCOUNTANT')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(note)) body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.housing.decide(id, false, body.note, user);
  }

  @Post('stages/:id/claim')
  @HttpCode(200)
  @Roles(...SUPERVISORS)
  claim(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(note)) body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.housing.claim(id, body.note, user);
  }

  @Post('stages/:id/verify')
  @HttpCode(200)
  @Roles(...SUPERVISORS)
  verify(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(note)) body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.housing.verify(id, body.note, user);
  }

  @Post('stages/:id/send-back')
  @HttpCode(200)
  @Roles(...SUPERVISORS)
  sendBack(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(note)) body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.housing.sendBack(id, body.note, user);
  }

  @Post('stages/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'PROJECT_SUPERVISOR', 'ACCOUNTANT')
  approveStage(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.housing.approveStage(id, user);
  }

  @Post('stages/:id/photos')
  @Roles(...SUPERVISORS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  photo(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @CurrentUser() user: AuthUser) {
    return this.housing.photo(id, file, user);
  }
}
