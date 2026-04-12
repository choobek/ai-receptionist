const crypto = require('node:crypto');

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function deriveKeyFromSecret(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function ensureKey(key) {
  if (!key || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Calendar gateway encryption key is not configured');
  }
}

function encryptJson(value, key) {
  ensureKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${toBase64Url(iv)}.${toBase64Url(authTag)}.${toBase64Url(ciphertext)}`;
}

function decryptJson(value, key) {
  ensureKey(key);
  const [version, ivPart, tagPart, cipherPart] = String(value || '').split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) {
    throw new Error('Unsupported encrypted payload format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromBase64Url(ivPart));
  decipher.setAuthTag(fromBase64Url(tagPart));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64Url(cipherPart)),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function signPayload(payload, key) {
  ensureKey(key);
  const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = crypto.createHmac('sha256', key).update(encodedPayload).digest();
  return `${encodedPayload}.${toBase64Url(signature)}`;
}

function verifySignedPayload(token, key) {
  ensureKey(key);
  const [encodedPayload, encodedSignature] = String(token || '').split('.');
  if (!encodedPayload || !encodedSignature) {
    throw new Error('Invalid signed token');
  }
  const expected = crypto.createHmac('sha256', key).update(encodedPayload).digest();
  const actual = fromBase64Url(encodedSignature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid signed token');
  }
  return JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
}

module.exports = {
  decryptJson,
  deriveKeyFromSecret,
  encryptJson,
  sha256Hex,
  signPayload,
  verifySignedPayload
};
