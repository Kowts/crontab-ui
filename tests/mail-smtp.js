'use strict';

/* global describe, it, expect */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');

function startSmtp(rejectRecipient) {
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 queued\r\n');
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 test\r\n');
        else if (command === 'MAIL') socket.write('250 ok\r\n');
        else if (command === 'RCPT') socket.write(rejectRecipient ? '550 5.1.1 mailbox rejected\r\n' : '250 ok\r\n');
        else if (command === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (command === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function deliver(rejectRecipient) {
  const server = await startSmtp(rejectRecipient);
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'crontab-ui-smtp-'));
  const env = {
    CRON_DB_PATH: dbPath,
    CRON_PATH: dbPath,
    NODE_ENV: 'test',
    MAIL_PROFILES_JSON: JSON.stringify({
      ops: { transporter: `smtp://127.0.0.1:${server.address().port}`, from: 'ui@example.test', to: 'ops@example.test' },
    }),
  };
  try {
    const created = await run(['-e', `
      const crontab = require('./crontab');
      crontab.create_new('mailed', 'echo hi', '* * * * *', false, { profileId: 'ops' }, {}, (error, job) => {
        if (error) { console.error(error.message); process.exit(1); }
        console.log('JOB:' + job._id);
      });
    `], env);
    const jobId = /JOB:(\S+)/.exec(created.output)?.[1];
    expect(jobId).toBeTruthy();
    const result = await run(['bin/crontab-ui-mailer.js', jobId, 'op-1', 'failed', '1200', '1'], env);
    const auditFile = path.join(dbPath, 'logs', 'operations.jsonl');
    const events = fs.existsSync(auditFile)
      ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'mail')
      : [];
    return { result, events };
  } finally {
    server.close();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
}

describe('SMTP delivery against a real server', () => {
  it('audits a rejected recipient and exits non-zero without crashing', async () => {
    const { result, events } = await deliver(true);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Mail delivery failed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'failed', operationId: 'op-1' });
    expect(events[0].error).toContain('550');
  }, 30000);

  it('audits a successful delivery', async () => {
    const { result, events } = await deliver(false);
    expect(result.code).toBe(0);
    expect(events[0]).toMatchObject({ status: 'completed' });
  }, 30000);
});
