/** مخزن مفاتيح وقيم فوق IndexedDB. القيم المحفوظة فيه مشفّرة قبل أن تصله (انظر vault.ts). */
const DB = 'eywaa-mobile';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      // يُنتظر تمام المعاملة لا نجاح الطلب: ما لم تتمّ لم يثبت على القرص.
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const kv = {
  get: <T>(key: string) => run<T>('readonly', (s) => s.get(key) as IDBRequest<T>),
  set: (key: string, value: unknown) => run('readwrite', (s) => { s.put(value, key); }),
  del: (key: string) => run('readwrite', (s) => { s.delete(key); }),
  clear: () => run('readwrite', (s) => { s.clear(); }),
};
