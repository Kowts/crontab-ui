#!/usr/bin/env node
'use strict';

const crontab = require('../crontab.js');
const nodemailer = require('nodemailer');
const { getProfile } = require('../config/mail-profiles');
const fs = require('fs');
const path = require('path');

const jobId = process.argv[2];
const operationId = process.argv[3];
const outcome = process.argv[4] === 'succeeded' || process.argv[4] === 'failed' ? process.argv[4] : 'unknown';
const durationMs = /^\d+$/.test(process.argv[5] || '') ? Number(process.argv[5]) : null;
const exitCode = /^-?\d+$/.test(process.argv[6] || '') ? process.argv[6] : 'unavailable';
const configuredAttachmentLimit = Number(process.env.MAIL_MAX_ATTACHMENT_BYTES || 512 * 1024);
const maxAttachmentBytes = Number.isSafeInteger(configuredAttachmentLimit)
  && configuredAttachmentLimit > 0 && configuredAttachmentLimit <= 10 * 1024 * 1024
  ? configuredAttachmentLimit : 512 * 1024;
const outputFolder = crontab.output_folder;

function formatDuration(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return 'unavailable';
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function readPrefix(file, limit) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    return buffer.subarray(0, fs.readSync(handle, buffer, 0, limit, 0));
  } finally {
    fs.closeSync(handle);
  }
}

// An unreadable or oversized output must never suppress the alert itself: the recipient still
// receives the outcome and is pointed at the full logs kept by the application. Oversized output
// is attached truncated so a first slice stays available for triage.
function outputAttachment(folder, id, name, limit) {
  const file = path.resolve(folder, `${id}.${name}`);
  if (!file.startsWith(`${path.resolve(folder)}${path.sep}`)) {
    return { notice: `${name} is outside the output folder and was not attached.` };
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_error) {
    return { notice: `${name} is not available and was not attached.` };
  }
  if (!stat.isFile()) return { notice: `${name} is not a regular file and was not attached.` };
  if (stat.size <= limit) {
    return { attachment: { filename: `${name}.txt`, content: fs.readFileSync(file), contentType: 'text/plain' } };
  }
  return {
    attachment: { filename: `${name}-truncated.txt`, content: readPrefix(file, limit), contentType: 'text/plain' },
    notice: `${name} exceeds the ${limit}-byte attachment limit and was attached truncated to its first ${limit} bytes.`,
  };
}

function collectOutputAttachments(folder, id, limit) {
  const results = ['stdout', 'stderr'].map((name) => outputAttachment(folder, id, name, limit));
  return {
    attachments: results.filter((item) => item.attachment).map((item) => item.attachment),
    notices: results.filter((item) => item.notice).map((item) => item.notice),
  };
}

function fail(error) {
  crontab.audit({ operationId, type: 'mail', jobId, status: 'failed', error: error.message });
  console.error(`Mail delivery failed: ${error.message}`);
  process.exitCode = 1;
}

function sendNotification() {
  crontab.get_crontab(jobId, (error, job) => {
    try {
      if (error) throw error;
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
      const output = collectOutputAttachments(outputFolder, jobId, maxAttachmentBytes);
      const outputMessage = output.notices.length > 0
        ? `${output.notices.join(' ')}\n\nThe complete output is available in the execution logs in Crontab UI.`
        : 'The job output is attached.';
      transporter.sendMail({
        from: profile.from,
        to: profile.to,
        subject: `Crontab UI job ${safeName} ${outcome} (${formatDuration(durationMs)}, exit ${exitCode})`,
        text: `Execution result: ${outcome}\nDuration: ${formatDuration(durationMs)}\nExit code: ${exitCode}\n\n${outputMessage}`,
        attachments: output.attachments,
      }, (error, info) => {
        if (error) return fail(error);
        crontab.audit({
          operationId,
          type: 'mail',
          jobId,
          status: 'completed',
          response: String(info.response || '').slice(0, 256),
          degradedAttachments: output.notices.length > 0,
          attachmentNotices: output.notices,
        });
        return console.log('Mail sent');
      });
    } catch (error) {
      fail(error);
    }
  });
}

if (require.main === module) sendNotification();

module.exports = { collectOutputAttachments, formatDuration };
