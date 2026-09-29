'use strict';

const { createApp, startServer } = require('./app');
const crontab = require('./crontab');

const server = startServer(createApp());

function shutdown(signal) {
  console.log(`Received ${signal}; stopping crontab-ui`);
  let serverClosed = false;
  let manualRunsStopped = false;
  const exitWhenReady = () => {
    if (serverClosed && manualRunsStopped) process.exit(0);
  };
  crontab.shutdownManualRuns(() => {
    manualRunsStopped = true;
    exitWhenReady();
  });
  server.close(() => {
    serverClosed = true;
    exitWhenReady();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
