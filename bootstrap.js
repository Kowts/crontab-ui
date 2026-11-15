'use strict';

const { createApp, startServer } = require('./app');
const crontab = require('./crontab');
const { validateProductionPrivileges } = require('./config/privileges');
const { validateFilePermissions } = require('./config/file-permissions');
const { startWatchdog } = require('./lib/alerting');

// Rejeita configurações inseguras antes de expôr o serviço.
validateProductionPrivileges({ nodeEnv: process.env.NODE_ENV });
validateFilePermissions({
  nodeEnv: process.env.NODE_ENV,
  dbFolder: crontab.db_folder,
  logFolder: crontab.log_folder,
  dbFile: crontab.crontab_db_file,
});

let nativeDispatcher = null;

function startApplication() {
  crontab.recoverManualRuns();
  const application = createApp();
  const server = startServer(application);
  startWatchdog({ health: application.locals.health, audit: crontab.audit });

  function shutdown(signal) {
    console.log(`Received ${signal}; stopping crontab-ui`);
    let serverClosed = false;
    let manualRunsStopped = false;
    let scheduledRunsStopped = !nativeDispatcher;
    const exitWhenReady = () => {
      if (serverClosed && manualRunsStopped && scheduledRunsStopped) process.exit(0);
    };
    if (nativeDispatcher) nativeDispatcher.close(() => {
      scheduledRunsStopped = true;
      exitWhenReady();
    });
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
}

if (process.env.ENABLE_NATIVE_DISPATCH === 'true') {
  require('./lib/native-dispatch').startNativeDispatcher(crontab)
    .then((dispatcher) => { nativeDispatcher = dispatcher; startApplication(); })
    .catch((error) => {
      console.error('Native dispatcher refused to start:', error.message);
      process.exit(1);
    });
} else {
  startApplication();
}
