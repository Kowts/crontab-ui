'use strict';

const { createApp, startServer } = require('./app');
const crontab = require('./crontab');
const { validateProductionPrivileges } = require('./config/privileges');
const { validateFilePermissions } = require('./config/file-permissions');

// Rejeita configurações inseguras antes de expôr o serviço.
validateProductionPrivileges({ nodeEnv: process.env.NODE_ENV });
validateFilePermissions({
  nodeEnv: process.env.NODE_ENV,
  dbFolder: crontab.db_folder,
  logFolder: crontab.log_folder,
  dbFile: crontab.crontab_db_file,
});

crontab.recoverManualRuns();
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
