'use strict';

// Per-task notification rules. The decision to send an email lives here rather than being spread
// across the save validator, the import normaliser and the run path, so a field cannot be accepted
// in one place and silently dropped in another.

const POLICIES = ['onFailure', 'onSuccess', 'always'];
const MAILING_KEYS = ['profileId', 'policy', 'alertAfterFailures', 'alertCooldownMinutes'];
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const DEFAULT_ALERT_AFTER_FAILURES = 1;
const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;
const MAX_ALERT_AFTER_FAILURES = 100;
const MAX_ALERT_COOLDOWN_MINUTES = 7 * 24 * 60;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// Returns the stored shape, or throws with a reason the caller can report. Only the keys a task
// may carry are kept, so an operator can never persist a field the run path would ignore.
function normaliseMailing(mailing) {
  if (mailing === undefined || mailing === null) return {};
  if (!isPlainObject(mailing) || Object.keys(mailing).some((key) => !MAILING_KEYS.includes(key))) {
    throw new Error('mailing contains unsupported fields');
  }
  const profileId = mailing.profileId;
  if (profileId !== undefined && profileId !== '') {
    if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error('mailing.profileId is invalid');
    }
  }
  if (mailing.policy !== undefined && !POLICIES.includes(mailing.policy)) {
    throw new Error('mailing.policy is invalid');
  }
  const hasProfile = typeof profileId === 'string' && profileId !== '';
  // A policy or a threshold without a destination has no meaning and is almost always a mistake.
  if (!hasProfile && (mailing.policy !== undefined
    || mailing.alertAfterFailures !== undefined
    || mailing.alertCooldownMinutes !== undefined)) {
    throw new Error('mailing requires a profileId when a policy or alert threshold is set');
  }
  if (!hasProfile) return {};
  const alertAfterFailures = boundedInteger(mailing.alertAfterFailures, {
    name: 'mailing.alertAfterFailures',
    min: 1,
    max: MAX_ALERT_AFTER_FAILURES,
    fallback: null,
  });
  const alertCooldownMinutes = boundedInteger(mailing.alertCooldownMinutes, {
    name: 'mailing.alertCooldownMinutes',
    min: 0,
    max: MAX_ALERT_COOLDOWN_MINUTES,
    fallback: null,
  });
  // Only what the operator actually chose is stored. An absent value keeps the effective default,
  // so a task that never uses these settings serialises exactly as it did before they existed.
  return {
    profileId,
    policy: mailing.policy || 'onFailure',
    ...(alertAfterFailures !== null && { alertAfterFailures }),
    ...(alertCooldownMinutes !== null && { alertCooldownMinutes }),
  };
}

// The existing policy decides whether a failure is worth notifying at all. This adds the two
// controls that stop one bad afternoon becoming a hundred emails, and stop a single transient
// failure becoming an alert. Success notifications are never throttled.
function failureAlertDue(mailing, { consecutiveFailures = 0, lastAlertAt = null, now = Date.now() } = {}) {
  const threshold = Number.isSafeInteger(mailing?.alertAfterFailures) ? mailing.alertAfterFailures : DEFAULT_ALERT_AFTER_FAILURES;
  if (consecutiveFailures < threshold) return { send: false, reason: 'below_failure_threshold' };
  const cooldownMinutes = Number.isSafeInteger(mailing?.alertCooldownMinutes)
    ? mailing.alertCooldownMinutes
    : DEFAULT_ALERT_COOLDOWN_MINUTES;
  if (lastAlertAt !== null && now - lastAlertAt < cooldownMinutes * 60 * 1000) {
    return { send: false, reason: 'alert_cooldown_active' };
  }
  return { send: true, reason: null };
}

module.exports = {
  normaliseMailing,
  failureAlertDue,
  POLICIES,
  MAILING_KEYS,
  PROFILE_ID_PATTERN,
  DEFAULT_ALERT_AFTER_FAILURES,
  DEFAULT_ALERT_COOLDOWN_MINUTES,
  MAX_ALERT_AFTER_FAILURES,
  MAX_ALERT_COOLDOWN_MINUTES,
};
