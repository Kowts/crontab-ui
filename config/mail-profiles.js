'use strict';

const MAX_RECIPIENTS = 20;
const MAX_TRANSPORTER_LENGTH = 2048;

function validateAddress(value, field) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n]/.test(value)
    || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value)) {
    throw new Error(`Mail profile has an invalid ${field} address`);
  }
  return value;
}

function normaliseRecipients(value) {
  const recipients = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) {
    throw new Error('Mail profile must define between 1 and 20 recipients');
  }
  return recipients.map((recipient) => validateAddress(recipient.trim(), 'recipient'));
}

function validateTransporter(value) {
  if (typeof value !== 'string' || value.length > MAX_TRANSPORTER_LENGTH || /[\r\n]/.test(value)) {
    throw new Error('Mail profile has an invalid transporter');
  }
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error('Mail profile has an invalid transporter');
  }
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Mail profile transporter must use smtp or smtps');
  }
  return value;
}

function loadProfiles() {
  if (!process.env.MAIL_PROFILES_JSON) return {};
  try {
    const profiles = JSON.parse(process.env.MAIL_PROFILES_JSON);
    return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
  } catch (_error) {
    throw new Error('MAIL_PROFILES_JSON must be a JSON object');
  }
}

function getProfile(profileId) {
  if (typeof profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profileId)) {
    throw new Error('Unknown or invalid mail profile');
  }
  const profile = loadProfiles()[profileId];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || Object.keys(profile).some((key) => !['transporter', 'from', 'to'].includes(key))) {
    throw new Error(`Unknown or invalid mail profile: ${profileId}`);
  }
  return {
    transporter: validateTransporter(profile.transporter),
    from: validateAddress(profile.from, 'from'),
    to: normaliseRecipients(profile.to),
  };
}

function listProfileIds() {
  return Object.keys(loadProfiles()).map((profileId) => {
    getProfile(profileId);
    return profileId;
  });
}

module.exports = { getProfile, listProfileIds, validateAddress, normaliseRecipients, validateTransporter };
