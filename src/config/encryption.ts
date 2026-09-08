import { config } from './env';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const algorithm = 'aes-256-gcm';
const key = Buffer.from(config.ENCRYPTION_KEY, 'base64');
const ivLength = config.ENCRYPTION_IV_LENGTH;

if (key.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (base64 encoded)');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

export function decrypt(encryptedData: string): string {
  const buffer = Buffer.from(encryptedData, 'base64');

  const iv = buffer.subarray(0, ivLength);
  const authTag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(ivLength, buffer.length - 16);

  const decipher = createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function encryptObject<T extends Record<string, unknown>>(obj: T): T {
  const encrypted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      encrypted[key] = encrypt(value);
    } else if (typeof value === 'object' && value !== null) {
      encrypted[key] = encryptObject(value as Record<string, unknown>);
    } else {
      encrypted[key] = value;
    }
  }
  return encrypted as T;
}

export function decryptObject<T extends Record<string, unknown>>(obj: T): T {
  const decrypted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      try {
        decrypted[key] = decrypt(value);
      } catch {
        decrypted[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      decrypted[key] = decryptObject(value as Record<string, unknown>);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted as T;
}