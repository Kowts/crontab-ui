'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.js'],
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      exclude: [
        'public/**',
        'bin/**',
        'bootstrap.js',
        'config/mailconfig.js',
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 65,
      },
    },
  },
});
