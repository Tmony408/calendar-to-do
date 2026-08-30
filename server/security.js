import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export function randomId() {
  return crypto.randomUUID();
}

export function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email }, required('JWT_SECRET'), { expiresIn: '7d' });
}

export function verifySession(token) {
  const payload = jwt.verify(token, required('JWT_SECRET'));
  if (!payload.sub) throw new Error('Invalid session');
  return { id: payload.sub, email: payload.email };
}

function encryptionKey() {
  const raw = required('TOKEN_ENCRYPTION_KEY');
  if (/^[a-f\d]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url, timezone: user.timezone };
}
