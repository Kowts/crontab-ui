#!/usr/bin/env node
'use strict';

// Prints a scrypt digest for a password so it can be stored in BASIC_AUTH_USERS_JSON instead of
// the password itself. The argument is read from argv, which is visible to other processes on the
// host, so the interactive prompt is the default and the argument is only for scripted setup.
const readline = require('readline');
const { hashPassword } = require('../config/passwords');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const password = process.argv[2] || await prompt('Password: ');
  if (!password) {
    console.error('A password is required.');
    process.exitCode = 1;
    return;
  }
  const digest = await hashPassword(password);
  console.log(JSON.stringify({ digest }));
  console.error('\nStore the digest, not the password:');
  console.error(`BASIC_AUTH_USERS_JSON={"your-user":"${digest}"}`);
}

main().catch((error) => {
  console.error(`Unable to hash the password: ${error.message}`);
  process.exitCode = 1;
});
