import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, id } from './store.mjs';
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const passwordHash = (password, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export function passwordMatches(password, stored) {
  const [salt, digest] = stored.split(':');
  return timingSafeEqual(
    Buffer.from(digest, 'hex'),
    Buffer.from(passwordHash(password, salt).split(':')[1], 'hex'),
  );
}
export class Vault {
  constructor(store) {
    this.store = store;
    const path = join(store.root, 'vault.key');
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(path);
  }
  save(text, ref = id()) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const sealed = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64');
    this.store.db.prepare('INSERT OR REPLACE INTO secrets VALUES(?,?)').run(ref, sealed);
    return ref;
  }
  read(ref) {
    const row = this.store.db.prepare('SELECT sealed FROM secrets WHERE id=?').get(ref);
    if (!row) fail('auth_required', 'Model credential is unavailable', 409);
    const bytes = Buffer.from(row.sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}
