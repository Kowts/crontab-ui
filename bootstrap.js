'use strict';

const { createApp, startServer } = require('./app');

const server = startServer(createApp());

function shutdown(signal) {
  console.log(`Received ${signal}; stopping crontab-ui`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
