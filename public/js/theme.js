'use strict';

/* global window, document */

(function(window, document) {
  const storageKey = 'crontab_ui_theme';

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function storedTheme() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return value === 'dark' || value === 'light' ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function currentTheme() {
    return document.documentElement.dataset.theme || storedTheme() || systemTheme();
  }

  function applyTheme(theme, persist) {
    const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.bsTheme = resolvedTheme;
    if (persist) {
      try {
        window.localStorage.setItem(storageKey, resolvedTheme);
      } catch (_error) {
        // Private browsing or browser policy may block local storage.
      }
    }
    return resolvedTheme;
  }

  window.CrontabUITheme = {
    current: currentTheme,
    apply: applyTheme,
    toggle: function() {
      return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    }
  };

  applyTheme(storedTheme() || systemTheme(), false);
})(window, document);
