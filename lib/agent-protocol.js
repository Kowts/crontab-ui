'use strict';

const crypto = require('crypto');

function canonicalMessage(timestamp, nonce, body) {
  return `${timestamp}\n${nonce}\n${body}`;
}

function signAgentRequest(secret, body, timestamp = Date.now(), nonce = crypto.randomUUID()) {
  if (!Buffer.isBuffer(secret) || secret.length < 32 || typeof body !== 'string'
    || !Number.isSafeInteger(timestamp) || !/^[0-9a-f-]{36}$/i.test(nonce)) {
    throw new Error('Invalid agent request signing input');
  }
  const signature = crypto.createHmac('sha256', secret)
    .update(canonicalMessage(timestamp, nonce, body))
    .digest('hex');
  return { timestamp, nonce, signature };
}

function verifyAgentRequest(secret, body, headers, { now = Date.now(), maxAgeMs = 30_000 } = {}) {
  const timestamp = Number(headers.timestamp);
  const nonce = headers.nonce;
  const signature = headers.signature;
  if (!Buffer.isBuffer(secret) || secret.length < 32 || typeof body !== 'string'
    || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxAgeMs
    || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce)
    || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(canonicalMessage(timestamp, nonce, body))
    .digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { signAgentRequest, verifyAgentRequest };
