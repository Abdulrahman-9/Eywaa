import {
  Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { AttachmentsService, CATEGORIES, MAX_FILE_BYTES } from './attachments.service';

const uploadSchema = z.object({ category: z.enum(CATEGORIES), personId: z.string().uuid().optional() });
const READERS = ['ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'AUDITOR'] as const;

@Controller()
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post('families/:id/attachments')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body(new ZodPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attachments.upload(id, file, body.category, body.personId, user);
  }

  @Get('families/:id/attachments')
  @Roles(...READERS)
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.list(id);
  }

  @Post('attachments/:id/link')
  @Roles(...READERS)
  link(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.attachments.issueLink(id, user);
  }

  @Delete('attachments/:id')
  @Roles('ADMIN', 'BENEFICIARY_SUPERVISOR')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.attachments.remove(id, user);
  }

  /** الرابط المؤقت نفسه هو الإذن؛ لذا لا يحتاج جلسة، ويُفتح في وسم الصورة مباشرة. */
  @Public()
  @Get('files/:token')
  async file(@Param('token') token: string, @Res() res: Response) {
    const { data, mime } = await this.attachments.readByToken(token);
    res.set({
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(data);
  }
}
