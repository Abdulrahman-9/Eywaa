import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { InventoryService, itemSchema, MoveInput, moveSchema, StocktakeInput, stocktakeSchema } from './inventory.service';

const KEEPERS = ['ADMIN', 'STOREKEEPER'] as const;
const READERS = ['ADMIN', 'STOREKEEPER', 'DISTRIBUTION_MANAGER', 'ACCOUNTANT', 'AUDITOR'] as const;
const noteSchema = z.object({ note: z.string().trim().min(1).optional() });

@Controller('inventory')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  @Get('items')
  @Roles(...READERS)
  items() {
    return this.inventory.items();
  }

  @Post('items')
  @Roles(...KEEPERS)
  createItem(@Body(new ZodPipe(itemSchema)) body: z.infer<typeof itemSchema>, @CurrentUser() user: AuthUser) {
    return this.inventory.createItem(body, user);
  }

  @Get('stock')
  @Roles(...READERS)
  stock() {
    return this.inventory.stock();
  }

  @Get('moves')
  @Roles(...READERS)
  moves(@Query('status') status?: string) {
    return this.inventory.moves(['PENDING', 'POSTED', 'REJECTED'].includes(status ?? '') ? status : undefined);
  }

  @Post('moves')
  @Roles(...KEEPERS)
  move(@Body(new ZodPipe(moveSchema)) body: MoveInput, @CurrentUser() user: AuthUser) {
    return this.inventory.move(body, user);
  }

  @Post('stocktake')
  @Roles(...KEEPERS)
  stocktake(@Body(new ZodPipe(stocktakeSchema)) body: StocktakeInput, @CurrentUser() user: AuthUser) {
    return this.inventory.stocktake(body, user);
  }

  @Post('moves/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'STOREKEEPER', 'DISTRIBUTION_MANAGER')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.inventory.decide(id, true, body.note, user);
  }

  @Post('moves/:id/reject')
  @HttpCode(200)
  @Roles('ADMIN', 'STOREKEEPER', 'DISTRIBUTION_MANAGER')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.inventory.decide(id, false, body.note, user);
  }

  @Get('reconcile/:campaignId')
  @Roles(...READERS)
  reconcile(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.inventory.reconcile(campaignId);
  }
}
