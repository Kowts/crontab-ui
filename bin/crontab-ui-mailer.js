#!/usr/bin/env node
'use strict';

const crontab = require('../crontab.js');
const nodemailer = require('nodemailer');
const { getProfile } = require('../config/mail-profiles');

const jobId = process.argv[process.argv.length - 3];
const stdoutPath = process.argv[process.argv.length - 2];
const stderrPath = process.argv[process.argv.length - 1];

crontab.get_crontab(jobId, (job) => {
  const profile = getProfile(job.mailing.profileId);
  const transporter = nodemailer.createTransport(profile.transporter, {
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const mailOptions = {
    from: profile.from,
    to: profile.to,
    subject: `Crontab UI job ${job.name || jobId} executed`,
    text: 'The job output is attached.',
  };

  mailOptions.attachments = [
    { filename: 'stdout.txt', path: stdoutPath },
    { filename: 'stderr.txt', path: stderrPath },
  ];

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return console.log(error);
    }
    console.log(`Message sent: ${info.response}`);
  });
});
