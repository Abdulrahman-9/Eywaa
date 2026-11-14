import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { FieldCrypto } from '../common/crypto';
import { Config } from '../config';
import { CONFIG } from '../db/db.module';

/**
 * مخزن الملفات. التنفيذ الحالي على القرص المحلي، والملف يُكتب مشفّراً.
 * عند النشر يُستبدل بمخزن متوافق مع S3 خلف الواجهة نفسها (put/get/remove).
 */
@Injectable()
export class Storage {
  private readonly root: string;

  constructor(@Inject(CONFIG) config: Config, @Inject(FieldCrypto) private readonly crypto: FieldCrypto) {
    this.root = resolve(config.STORAGE_DIR);
  }

  private path(key: string): string {
    if (!/^[a-f0-9/-]+$/.test(key)) throw new Error('invalid storage key');
    return join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.path(key);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, this.crypto.encryptBuffer(data), { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return this.crypto.decryptBuffer(await fs.readFile(this.path(key)));
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }
}
