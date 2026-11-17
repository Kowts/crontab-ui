'use strict';

/* global describe, it, expect, beforeAll, afterAll */
const rules = require('../config/run-parameters');

describe('Run parameter browser helpers', () => {
  let client;
  const originalDocument = globalThis.document;

  beforeAll(() => {
    globalThis.CrontabRunParameterRules = rules;
    // The editor renders only when its container exists; these tests exercise the data paths.
    globalThis.document = { getElementById: () => null };
    client = require('../public/js/run-parameters');
  });

  afterAll(() => {
    delete globalThis.CrontabRunParameterRules;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const definitions = rules.validateRunParameterDefinitions([
    { name: 'date', flag: '--date', type: 'date', label: 'Processing date', min: '2026-01-01', help: 'Empty: the script decides.' },
    { name: 'delete', flag: '--delete', type: 'flag', label: 'Delete', confirm: true, min_role: 'operator' },
    { name: 'quiet', flag: '-q', type: 'flag', label: 'Quiet', default: true },
    { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', style: 'equals', required: true,
      options: [{ value: 'full', label: 'Full load' }, { value: 'delta', label: 'delta' }], default: 'delta' },
    { name: 'batch', flag: '--batch', type: 'integer', label: 'Batch', min: 1, max: 500, default: 100 },
    { name: 'region', flag: '--region', type: 'text', label: 'Region', pattern: '[A-Z]{2}', max_length: 2 },
  ]);

  it('round-trips stored definitions through the editor without changing them', () => {
    client.fillEditor(definitions);
    const edited = client.readEditor();
    expect(rules.validateRunParameterDefinitions(edited)).toEqual(definitions);
    expect(edited.find((definition) => definition.name === 'quiet')).toEqual({
      name: 'quiet', flag: '-q', type: 'flag', label: 'Quiet', default: true,
    });
    expect(edited.find((definition) => definition.name === 'date')).not.toHaveProperty('max');
  });

  it('reads select options as value|label lines', () => {
    expect(client.textToOptions('full|Full load\n\n delta \nx|')).toEqual([
      { value: 'full', label: 'Full load' }, { value: 'delta', label: 'delta' }, { value: 'x', label: '' },
    ]);
    expect(client.optionsToText([{ value: 'full', label: 'Full load' }, { value: 'delta', label: 'delta' }]))
      .toBe('full|Full load\ndelta');
  });

  it('formats the active values of a past run as argv tokens', () => {
    expect(client.formatValues(definitions, { date: '2026-11-15', delete: true, mode: 'full' }))
      .toBe('--date 2026-11-15 --delete --mode=full');
    const free = rules.validateRunParameterDefinitions([{ name: 'ref', flag: '--ref', type: 'text', label: 'Ref', pattern: '.*' }]);
    expect(client.formatValues(free, { ref: 'a b' })).toBe('--ref "a b"');
    expect(client.formatValues(definitions, null)).toBe('');
    expect(client.formatValues(definitions, {})).toBe('');
    // A value that no longer fits the current definition is still shown, without throwing.
    expect(client.formatValues(definitions, { removed: 'x' })).toBe('removed=x');
  });

  it('compares the current role with the minimum role of each parameter', () => {
    client.init({ role: 'executor' });
    expect(client.allowedForRole({ min_role: 'executor' })).toBe(true);
    expect(client.allowedForRole({ min_role: 'operator' })).toBe(false);
    expect(client.allowedForRole({ min_role: 'operator' }, 'admin')).toBe(true);
    expect(client.allowedForRole({ min_role: 'executor' }, 'viewer')).toBe(false);
    expect(client.allowedForRole({ min_role: 'executor' }, null)).toBe(false);
  });

  it('detects tasks that open the run form', () => {
    expect(client.hasRunParameters({ execution_mode: 'structured', structured_execution: { run_parameters: definitions } })).toBe(true);
    expect(client.hasRunParameters({ execution_mode: 'structured', structured_execution: {} })).toBe(false);
    expect(client.hasRunParameters({ execution_mode: 'command', command: 'echo' })).toBe(false);
    expect(client.hasRunParameters(undefined)).toBe(false);
  });
});
