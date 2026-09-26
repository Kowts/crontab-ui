'use strict';

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHELL_SYNTAX = /[\$`;&|<>]/;

function parseEnvironment(value) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
    throw new Error('Invalid environment variables payload');
  }
  if (!value) return {};

  const environment = {};
  for (const line of value.split('\n')) {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('Each environment line must be NAME=value');
    const name = line.slice(0, index);
    const variableValue = line.slice(index + 1);
    if (!NAME.test(name) || SHELL_SYNTAX.test(variableValue)) {
      throw new Error('Invalid environment variable definition');
    }
    environment[name] = variableValue;
  }
  return environment;
}

function serialiseEnvironment(environment) {
  return Object.entries(environment).map(([name, value]) => `${name}=${value}`).join('\n');
}

module.exports = { parseEnvironment, serialiseEnvironment };
