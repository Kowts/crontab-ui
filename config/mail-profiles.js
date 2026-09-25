'use strict';

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
  const profile = loadProfiles()[profileId];
  if (!profile || typeof profile.transporter !== 'string' || typeof profile.from !== 'string') {
    throw new Error(`Unknown or invalid mail profile: ${profileId}`);
  }
  return profile;
}

module.exports = { getProfile };
