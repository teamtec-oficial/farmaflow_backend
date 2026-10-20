import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 12;

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await deriveKey(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, storedPassword: string): Promise<boolean> {
  if (!storedPassword.startsWith('scrypt$')) return storedPassword === password;

  const [, saltHex, keyHex] = storedPassword.split('$');
  if (!saltHex || !keyHex || !/^[\da-f]+$/i.test(saltHex) || !/^[\da-f]+$/i.test(keyHex)) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expectedKey = Buffer.from(keyHex, 'hex');
  if (salt.length !== SCRYPT_SALT_LENGTH || expectedKey.length !== SCRYPT_KEY_LENGTH) return false;

  const actualKey = await deriveKey(password, salt);
  return timingSafeEqual(expectedKey, actualKey);
}
