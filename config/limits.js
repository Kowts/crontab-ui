'use strict';

// Two ways of reading a numeric setting, deliberately different.
//
// requireBoundedNumber refuses a bad value loudly, for configuration whose mistuning should stop
// the service rather than be silently normalised. It suits security limits, where a weaker value
// than intended is worse than not starting.
//
// useBoundedNumber falls back quietly, for limits that only bound cost or retention. Refusing to
// start because a retention setting has a typo would be a worse outcome than using the default,
// and the values involved are not safety boundaries.

function parseBoundedNumber(name, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return null;
  return value;
}

function requireBoundedNumber(name, minimum, maximum) {
  const value = parseBoundedNumber(name, minimum, maximum);
  if (value === null) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function useBoundedNumber(name, fallback, minimum, maximum) {
  const value = parseBoundedNumber(name, minimum, maximum);
  return value === undefined || value === null ? fallback : value;
}

function useCommandTimeoutMs() {
  return process.env.COMMAND_TIMEOUT_MS === '0'
    ? 0 : useBoundedNumber('COMMAND_TIMEOUT_MS', 300000, 1000, 24 * 60 * 60 * 1000);
}

module.exports = { requireBoundedNumber, useBoundedNumber, useCommandTimeoutMs };
