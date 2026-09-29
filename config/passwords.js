'use strict';

const crypto = require('crypto');

// Server-side password storage. A stored value is either a scrypt digest, which is what a real
// deployment should use, or a literal password kept for loopback development. The algorithm name is
// the version tag: changing a parameter below means storing under a new tag, so existing digests
// stay verifiable instead of silently becoming invalid.
const ALGORITHM = 'scrypt';
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PARAMETERS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function isDigest(value) {
  return typeof value === 'string' && value.startsWith(`${ALGORITHM}:`);
}

// Used when the submitted user does not exist, so a wrong username costs the same work as a wrong
// password and the response time does not disclose which accounts are configured.
const decoyDigest = `scrypt:${'0'.repeat(SALT_LENGTH * 2)}:${'0'.repeat(KEY_LENGTH * 2)}`;

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      KEY_LENGTH,
      { ...PARAMETERS },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('A password is required');
  const salt = crypto.randomBytes(SALT_LENGTH);
  return derive(password, salt).then((derived) => {
    return `${ALGORITHM}:${salt.toString('hex')}:${derived.toString('hex')}`;
  });
}

function parseDigest(stored) {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== ALGORITHM) throw new Error('Unsupported password digest');
  if (!/^[0-9a-f]+$/.test(parts[1]) || !/^[0-9a-f]+$/.test(parts[2])) {
    throw new Error('Malformed password digest');
  }
  return { salt: Buffer.from(parts[1], 'hex'), expected: Buffer.from(parts[2], 'hex') };
}

function isValidDigestFormat(value) {
  if (!isDigest(value)) return false;
  try {
    const { expected } = parseDigest(value);
    return expected.length === KEY_LENGTH;
  } catch (_error) {
    return false;
  }
}

// Verification is constant time for equal-length digests. A malformed stored value is reported as
// a failure to verify rather than thrown, so a bad configuration cannot turn a sign-in into a 500.
async function verifyPassword(password, stored) {
  const candidate = stored || decoyDigest;
  if (!isDigest(candidate)) {
    // Development credentials are compared directly, still in constant time.
    const left = Buffer.from(String(password), 'utf8');
    const right = Buffer.from(String(candidate), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
  let parsed;
  try {
    parsed = parseDigest(candidate);
  } catch (_error) {
    return false;
  }
  let derived;
  try {
    derived = await derive(password, parsed.salt);
  } catch (_error) {
    return false;
  }
  return derived.length === parsed.expected.length && crypto.timingSafeEqual(derived, parsed.expected);
}

module.exports = { hashPassword, verifyPassword, isDigest, isValidDigestFormat, ALGORITHM };
