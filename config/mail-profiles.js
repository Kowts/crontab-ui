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

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateProfileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error('Unknown or invalid mail profile');
  }
  return value;
}

function readProfile(profiles, profileId) {
  validateProfileId(profileId);
  const profile = profiles[profileId];
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

function getProfile(profileId) {
  return readProfile(loadProfiles(), profileId);
}

function listProfileIds() {
  return Object.keys(loadProfiles()).map((profileId) => {
    readProfile(loadProfiles(), profileId);
    return profileId;
  });
}

// Validates the whole configuration at once. A profile that is unusable at delivery time must be
// reported when the service starts, not hours later when the first task that selects it fails.
// Every problem is reported, so one typo does not hide the rest of the configuration.
function validateAllProfiles() {
  const profiles = loadProfiles();
  const problems = [];
  for (const profileId of Object.keys(profiles)) {
    try {
      readProfile(profiles, profileId);
    } catch (error) {
      problems.push(`${profileId}: ${error.message}`);
    }
  }
  if (problems.length) {
    throw new Error(`Invalid MAIL_PROFILES_JSON configuration: ${problems.join('; ')}`);
  }
  return Object.keys(profiles);
}

module.exports = {
  getProfile, listProfileIds, validateAllProfiles, validateProfileId, validateAddress, normaliseRecipients, validateTransporter,
};
