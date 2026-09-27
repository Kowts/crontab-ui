#!/usr/bin/env node
'use strict';

const crontab = require('../crontab.js');
const nodemailer = require('nodemailer');
const { getProfile } = require('../config/mail-profiles');
const fs = require('fs');
const path = require('path');

const jobId = process.argv[2];
const operationId = process.argv[3];
const configuredAttachmentLimit = Number(process.env.MAIL_MAX_ATTACHMENT_BYTES || 512 * 1024);
const maxAttachmentBytes = Number.isSafeInteger(configuredAttachmentLimit)
  && configuredAttachmentLimit > 0 && configuredAttachmentLimit <= 10 * 1024 * 1024
  ? configuredAttachmentLimit : 512 * 1024;
const outputFolder = crontab.output_folder;

function outputAttachment(name) {
  const file = path.resolve(outputFolder, `${jobId}.${name}`);
  const expectedFolder = `${path.resolve(outputFolder)}${path.sep}`;
  if (!file.startsWith(expectedFolder)) throw new Error('Invalid output attachment path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxAttachmentBytes) throw new Error('Output attachment is unavailable or exceeds the size limit');
  return { filename: `${name}.txt`, content: fs.readFileSync(file), contentType: 'text/plain' };
}

function fail(error) {
  crontab.audit({ operationId, type: 'mail', jobId, status: 'failed', error: error.message });
  console.error(`Mail delivery failed: ${error.message}`);
  process.exitCode = 1;
}

crontab.get_crontab(jobId, (job) => {
  try {
    if (!job?.mailing?.profileId) throw new Error('Job has no mail profile');
    const profile = getProfile(job.mailing.profileId);
    const safeName = String(job.name || jobId).replace(/[\r\n]/g, ' ').slice(0, 128);
    const transporter = nodemailer.createTransport(profile.transporter, {
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    transporter.sendMail({
      from: profile.from,
      to: profile.to,
      subject: `Crontab UI job ${safeName} executed`,
      text: 'The job output is attached.',
      attachments: [outputAttachment('stdout'), outputAttachment('stderr')],
    }, (error, info) => {
      if (error) return fail(error);
      crontab.audit({ operationId, type: 'mail', jobId, status: 'completed', response: String(info.response || '').slice(0, 256) });
      return console.log('Mail sent');
    });
  } catch (error) {
    fail(error);
  }
});
