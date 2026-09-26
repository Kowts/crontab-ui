#!/usr/bin/env node
'use strict';

const crontab = require('../crontab');

const jobId = process.argv[2];
if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId || '')) process.exit(2);

crontab.runjob(jobId, (error) => process.exit(error ? 1 : 0));
