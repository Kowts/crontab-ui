#!/usr/bin/env node
'use strict';

const crontab = require('../crontab');

const jobId = process.argv[2];
if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId || '')) process.exit(2);

async function run() {
  const job = await crontab.getJobForNativeDispatch(jobId);
  const environment = job?.execution_mode === 'structured'
    ? crontab.getExecutionEnvironment(job.structured_execution?.environment_id) : null;
  if (environment?.targetId === 'native-local') {
    const { dispatchScheduledNative } = require('../lib/native-dispatch');
    await dispatchScheduledNative(job, crontab.db_folder);
    return;
  }
  await new Promise((resolve, reject) => crontab.runjob(jobId, (error) => error ? reject(error) : resolve()));
}

run().then(() => process.exit(0)).catch((error) => {
  console.error('Scheduled execution failed:', error.message);
  process.exit(1);
});
