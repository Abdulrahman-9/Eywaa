import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Channels } from './channels';
import { NotificationsService } from './notifications.service';

/**
 * عامل الطابور: كل ثانية يرسل حتى MSG_RATE_PER_SEC رسالة (الافتراضي 10)، فلا يتجاوز النظامُ حدَّ المزوّد.
 * لا يعمل مع المحاكاة (تُرسل في الحال)، ويُطفأ بـMSG_WORKER=off.
 */
@Injectable()
export class MessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MessageWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(Channels) private readonly channels: Channels,
  ) {}

  onModuleInit() {
    if (process.env.MSG_WORKER === 'off') return;
    const rate = Math.max(1, Math.min(200, Number(process.env.MSG_RATE_PER_SEC) || 10));
    this.timer = setInterval(() => void this.tick(rate), 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(rate: number) {
    // الدورة التي لم تنتهِ لا تتراكب عليها أخرى: مزوّد بطيء يبطّئ الإرسال ولا يضاعفه.
    if (this.busy || !this.channels.current.live) return;
    this.busy = true;
    try {
      await this.notifications.processQueue(rate);
    } catch (err) {
      this.log.error(`تعذّرت دورة الإرسال: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
