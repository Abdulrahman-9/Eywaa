import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { migrate } from '../src/db/migrate';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://eywaa:eywaa@localhost:5432/eywaa_test';
export const PASSWORD = 'correct-horse-battery';

export async function sql(text: string, params: unknown[] = []) {
  const client = new Client({ connectionString: TEST_DB });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

export async function startApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.FIELD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.FIELD_HMAC_KEY = randomBytes(32).toString('base64');
  process.env.TOKEN_SIGNING_SEED = randomBytes(32).toString('base64');
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'eywaa-storage-'));

  await sql('drop schema public cascade; create schema public;');
  await migrate(TEST_DB);

  const hash = await hashPassword(PASSWORD);
  for (const [username, role] of [
    ['admin', 'ADMIN'], ['researcher', 'FIELD_RESEARCHER'], ['researcher2', 'FIELD_RESEARCHER'],
    ['supervisor', 'BENEFICIARY_SUPERVISOR'], ['distributor', 'DISTRIBUTOR'], ['distributor2', 'DISTRIBUTOR'],
    ['manager', 'DISTRIBUTION_MANAGER'], ['manager2', 'DISTRIBUTION_MANAGER'], ['auditor', 'AUDITOR'],
  ]) {
    await sql('insert into users (username, full_name, password_hash, role) values ($1,$1,$2,$3)', [username, hash, role]);
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

export async function login(app: INestApplication, username: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.body.token;
}

let counter = 0;
/** رقم بطاقة وطنية فريد من 12 خانة. */
export function nationalNo(): string {
  return String(100000000000 + ++counter);
}

const LETTERS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
/** اسم عربي فريد لكل رقم، كي لا تتشابه أسماء العيّنات فتُرفع عليها شبهات. */
export function uniqueName(n: number): string {
  const word = (seed: number) => {
    let out = '';
    for (let x = seed + 28 ** 4; x > 0; x = Math.floor(x / 28)) out += LETTERS[x % 28];
    return out;
  };
  return `${word(n * 7919)} ${word(n * 104729)} ${word(n * 1299709)}`;
}

export function family(overrides: Record<string, any> = {}): any {
  return {
    tags: ['WIDOW'],
    phone1: `0770${String(1000000 + ++counter)}`,
    address: { mahalla: 'الجولان', street: '12', house: '7', landmark: 'قرب الجامع' },
    housing: 'RENTED',
    members: [
      {
        relation: 'HEAD', fullName: uniqueName(counter), motherName: uniqueName(counter + 500000),
        gender: 'F', birthDate: '1980-05-01',
        documents: [{ type: 'NATIONAL_CARD', number: nationalNo() }],
      },
    ],
    incomes: [],
    proxies: [],
    ...overrides,
  };
}
