'use strict';

// Logs the first occurrence immediately, then at most once per interval while the same condition
// persists, so a prolonged failure does not flood stderr. reset() re-arms it after recovery.
function createLogThrottle(intervalMs, now = Date.now) {
  let lastLoggedAt = null;
  return {
    shouldLog() {
      const current = now();
      if (lastLoggedAt !== null && current - lastLoggedAt < intervalMs) return false;
      lastLoggedAt = current;
      return true;
    },
    reset() {
      lastLoggedAt = null;
    },
  };
}

module.exports = { createLogThrottle };
