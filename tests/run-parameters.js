'use strict';

/* global describe, it, expect */
const { resolveRunParameters, validateRunParameterDefinitions } = require('../config/run-parameters');

const siebel = [
  { name: 'date', flag: '--date', type: 'date', label: 'Processing date' },
  { name: 'delete', flag: '--delete', type: 'flag', label: 'Delete existing records', confirm: true, min_role: 'operator' },
  { name: 'delete_all', flag: '--deleteAll', type: 'flag', label: 'Delete all records', confirm: true, min_role: 'admin' },
  { name: 'no_mail', flag: '--no-mail', type: 'flag', label: 'Skip email' },
];

function rejects(fn, pattern, parameter) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.statusCode).toBe(422);
  expect(caught.code).toBe('INVALID_RUN_PARAMETERS');
  if (pattern) expect(caught.message).toMatch(pattern);
  if (parameter !== undefined) expect(caught.parameter).toBe(parameter);
}

describe('Run parameter definitions', () => {
  it('treats missing definitions as an empty list', () => {
    expect(validateRunParameterDefinitions(undefined)).toEqual([]);
    expect(validateRunParameterDefinitions(null)).toEqual([]);
    expect(validateRunParameterDefinitions([])).toEqual([]);
  });

  it('normalizes defaults for every field', () => {
    const [date, remove] = validateRunParameterDefinitions(siebel);
    expect(date).toEqual({
      name: 'date', flag: '--date', type: 'date', label: 'Processing date', help: null,
      required: false, confirm: false, min_role: 'executor', style: 'separate', min: null, max: null, default: null,
    });
    expect(remove).toEqual({
      name: 'delete', flag: '--delete', type: 'flag', label: 'Delete existing records', help: null,
      required: false, confirm: true, min_role: 'operator', default: false,
    });
    expect(remove).not.toHaveProperty('style');
  });

  it('is idempotent, so stored and backed-up definitions validate again unchanged', () => {
    const normalized = validateRunParameterDefinitions([
      ...siebel,
      { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', options: [{ value: 'full', label: 'Full' }], style: 'equals' },
      { name: 'batch', flag: '--batch', type: 'integer', label: 'Batch', min: 1, max: 9, default: 3 },
      { name: 'code', flag: '--code', type: 'text', label: 'Code', pattern: '[A-Z]{3}', help: 'Three letters' },
    ]);
    const roundTrip = JSON.parse(JSON.stringify(normalized));
    expect(validateRunParameterDefinitions(roundTrip)).toEqual(normalized);
  });

  it('accepts each supported type with its own fields', () => {
    const definitions = validateRunParameterDefinitions([
      { name: 'month', flag: '--month', type: 'date', label: 'Month', min: '2026-01-01', max: '2026-12-31', style: 'equals' },
      { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', options: [{ value: 'full', label: 'Full' }, { value: 'delta', label: 'Delta' }], default: 'delta' },
      { name: 'batch', flag: '--batch', type: 'integer', label: 'Batch', min: 1, max: 500, default: 100 },
      { name: 'region', flag: '--region', type: 'text', label: 'Region', pattern: '[A-Z]{2}', max_length: 2, required: true },
    ]);
    expect(definitions.map((definition) => definition.type)).toEqual(['date', 'select', 'integer', 'text']);
    expect(definitions[1].default).toBe('delta');
    expect(definitions[2]).toMatchObject({ min: 1, max: 500, default: 100 });
    expect(definitions[3]).toMatchObject({ pattern: '[A-Z]{2}', max_length: 2, required: true });
  });

  it('rejects malformed lists and definitions', () => {
    rejects(() => validateRunParameterDefinitions({}), /list/);
    rejects(() => validateRunParameterDefinitions(Array.from({ length: 21 }, (_, index) => (
      { name: `p${index}`, flag: `--p${index}`, type: 'flag', label: 'P' }))), /up to 20/);
    rejects(() => validateRunParameterDefinitions(['--date']), /must be an object/);
  });

  it('rejects invalid names, flags, types and unknown fields', () => {
    for (const name of ['Date', '1date', '__proto__', 'a'.repeat(33), '']) {
      rejects(() => validateRunParameterDefinitions([{ name, flag: '--x', type: 'flag', label: 'X' }]), /name is invalid/);
    }
    for (const flag of ['date', '---date', '--', '--da te', '--date=1', `--${'a'.repeat(64)}`]) {
      rejects(() => validateRunParameterDefinitions([{ name: 'x', flag, type: 'flag', label: 'X' }]), /invalid flag/, 'x');
    }
    rejects(() => validateRunParameterDefinitions([{ name: 'x', flag: '--x', type: 'password', label: 'X' }]), /unsupported type/, 'x');
    rejects(() => validateRunParameterDefinitions([{ name: 'x', flag: '--x', type: 'flag', label: 'X', pattern: '.*' }]), /unsupported field pattern/, 'x');
    rejects(() => validateRunParameterDefinitions([{ name: 'x', flag: '--x', type: 'flag', label: 'X', requires: ['y'] }]), /unsupported field requires/, 'x');
  });

  it('rejects duplicate names, duplicate flags and collisions with fixed arguments', () => {
    rejects(() => validateRunParameterDefinitions([
      { name: 'x', flag: '--x', type: 'flag', label: 'X' },
      { name: 'x', flag: '--y', type: 'flag', label: 'Y' },
    ]), /more than once/, 'x');
    rejects(() => validateRunParameterDefinitions([
      { name: 'x', flag: '--x', type: 'flag', label: 'X' },
      { name: 'y', flag: '--x', type: 'flag', label: 'Y' },
    ]), /more than one parameter/, 'y');
    rejects(() => validateRunParameterDefinitions(siebel, ['--verbose', '--date']), /fixed arguments/, 'date');
    rejects(() => validateRunParameterDefinitions(siebel, ['--no-mail=1']), /fixed arguments/, 'no_mail');
    expect(validateRunParameterDefinitions(siebel, ['--dated', '--verbose'])).toHaveLength(4);
  });

  it('rejects invalid labels, help, booleans, roles and styles', () => {
    const base = { name: 'x', flag: '--x', type: 'date' };
    rejects(() => validateRunParameterDefinitions([{ ...base }]), /label/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: '   ' }]), /label/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'a\nb' }]), /label/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'X', help: 'h'.repeat(201) }]), /help/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'X', required: 'yes' }]), /required must be a boolean/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'X', confirm: 1 }]), /confirm must be a boolean/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'X', min_role: 'viewer' }]), /min_role/, 'x');
    rejects(() => validateRunParameterDefinitions([{ ...base, label: 'X', style: 'joined' }]), /style/, 'x');
    rejects(() => validateRunParameterDefinitions([{ name: 'x', flag: '--x', type: 'flag', label: 'X', required: true }]), /cannot be required/, 'x');
    rejects(() => validateRunParameterDefinitions([{ name: 'x', flag: '--x', type: 'flag', label: 'X', style: 'equals' }]), /cannot define a style/, 'x');
  });

  it('rejects invalid type-specific fields and defaults', () => {
    const date = { name: 'd', flag: '--d', type: 'date', label: 'D' };
    rejects(() => validateRunParameterDefinitions([{ ...date, min: '2026-02-30' }]), /invalid min date/, 'd');
    rejects(() => validateRunParameterDefinitions([{ ...date, min: '2026-12-01', max: '2026-01-01' }]), /min date after/, 'd');
    rejects(() => validateRunParameterDefinitions([{ ...date, default: '15/11/2026' }]), /valid date/, 'd');
    rejects(() => validateRunParameterDefinitions([{ ...date, max: '2026-01-01', default: '2026-06-01' }]), /date range/, 'd');

    const integer = { name: 'n', flag: '--n', type: 'integer', label: 'N' };
    rejects(() => validateRunParameterDefinitions([integer]), /min and max/, 'n');
    rejects(() => validateRunParameterDefinitions([{ ...integer, min: 5, max: 1 }]), /min and max/, 'n');
    rejects(() => validateRunParameterDefinitions([{ ...integer, min: 0.5, max: 1 }]), /min and max/, 'n');
    rejects(() => validateRunParameterDefinitions([{ ...integer, min: 1, max: 5, default: 9 }]), /between 1 and 5/, 'n');

    const select = { name: 's', flag: '--s', type: 'select', label: 'S' };
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [] }]), /options/, 's');
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [{ value: '-x', label: 'X' }] }]), /invalid option/, 's');
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [{ value: 'a b', label: 'X' }] }]), /invalid option/, 's');
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [{ value: 'a', label: 'A', extra: 1 }] }]), /invalid option/, 's');
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }]), /duplicate/, 's');
    rejects(() => validateRunParameterDefinitions([{ ...select, options: [{ value: 'a', label: 'A' }], default: 'b' }]), /defined options/, 's');

    const text = { name: 't', flag: '--t', type: 'text', label: 'T' };
    rejects(() => validateRunParameterDefinitions([text]), /pattern/, 't');
    rejects(() => validateRunParameterDefinitions([{ ...text, pattern: '(' }]), /invalid pattern/, 't');
    rejects(() => validateRunParameterDefinitions([{ ...text, pattern: 'a'.repeat(257) }]), /pattern/, 't');
    rejects(() => validateRunParameterDefinitions([{ ...text, pattern: '.*', max_length: 257 }]), /max_length/, 't');
    rejects(() => validateRunParameterDefinitions([{ ...text, pattern: '.*', default: '--deleteAll' }]), /invalid value/, 't');

    rejects(() => validateRunParameterDefinitions([{ name: 'f', flag: '--f', type: 'flag', label: 'F', default: 'true' }]), /true or false/, 'f');
  });
});

describe('Run parameter resolution', () => {
  const definitions = validateRunParameterDefinitions(siebel);

  it('emits nothing when every value is empty or false', () => {
    expect(resolveRunParameters(definitions, undefined)).toEqual({ values: {}, tokens: [], active: [], arguments: [] });
    expect(resolveRunParameters(definitions, { date: '', delete: false }, ['--verbose']).arguments).toEqual(['--verbose']);
  });

  it('composes fixed arguments followed by tokens in definition order', () => {
    const resolved = resolveRunParameters(definitions, { no_mail: true, delete: true, date: '2026-11-15' }, ['--verbose']);
    expect(resolved.arguments).toEqual(['--verbose', '--date', '2026-11-15', '--delete', '--no-mail']);
    expect(resolved.values).toEqual({ date: '2026-11-15', delete: true, no_mail: true });
    expect(resolved.active).toEqual([
      { name: 'date', confirm: false, min_role: 'executor' },
      { name: 'delete', confirm: true, min_role: 'operator' },
      { name: 'no_mail', confirm: false, min_role: 'executor' },
    ]);
  });

  it('applies defaults to omitted keys and lets explicit values override them', () => {
    const withDefaults = validateRunParameterDefinitions([
      { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', options: [{ value: 'full', label: 'Full' }, { value: 'delta', label: 'Delta' }], default: 'delta', style: 'equals' },
      { name: 'quiet', flag: '-q', type: 'flag', label: 'Quiet', default: true },
    ]);
    expect(resolveRunParameters(withDefaults, {}).arguments).toEqual(['--mode=delta', '-q']);
    expect(resolveRunParameters(withDefaults, { mode: 'full', quiet: false }).arguments).toEqual(['--mode=full']);
    expect(resolveRunParameters(withDefaults, { mode: null }).arguments).toEqual(['-q']);
  });

  it('requires mandatory values', () => {
    const required = validateRunParameterDefinitions([{ name: 'date', flag: '--date', type: 'date', label: 'Date', required: true }]);
    rejects(() => resolveRunParameters(required, {}), /is required/, 'date');
    rejects(() => resolveRunParameters(required, { date: '' }), /is required/, 'date');
    expect(resolveRunParameters(required, { date: '2026-11-15' }).tokens).toEqual(['--date', '2026-11-15']);
  });

  it('rejects unknown keys, non-object values and wrong types', () => {
    rejects(() => resolveRunParameters(definitions, { force: true }), /Unknown run parameter force/, 'force');
    rejects(() => resolveRunParameters(definitions, ['--deleteAll']), /must be an object/);
    rejects(() => resolveRunParameters(definitions, 'date=2026-11-15'), /must be an object/);
    rejects(() => resolveRunParameters(definitions, { delete: 'true' }), /true or false/, 'delete');
    rejects(() => resolveRunParameters(definitions, { delete: 1 }), /true or false/, 'delete');
  });

  it('rejects impossible, malformed and out-of-range dates', () => {
    for (const date of ['2026-02-30', '2026-13-01', '26-11-15', '2026-11-15T00:00:00Z', '--deleteAll', 20261115]) {
      rejects(() => resolveRunParameters(definitions, { date }), /valid date/, 'date');
    }
    const bounded = validateRunParameterDefinitions([{ name: 'date', flag: '--date', type: 'date', label: 'D', min: '2026-01-01', max: '2026-12-31' }]);
    rejects(() => resolveRunParameters(bounded, { date: '2025-12-31' }), /date range/, 'date');
    rejects(() => resolveRunParameters(bounded, { date: '2027-01-01' }), /date range/, 'date');
    expect(resolveRunParameters(bounded, { date: '2026-12-31' }).values.date).toBe('2026-12-31');
    expect(resolveRunParameters(definitions, { date: '2024-02-29' }).values.date).toBe('2024-02-29');
  });

  it('accepts months as YYYY-MM, with limits and both argument styles', () => {
    const [month] = validateRunParameterDefinitions([
      { name: 'period', flag: '--date', type: 'month', label: 'Period', style: 'equals', min: '2025-01', max: '2026-12', default: '2025-12' },
    ]);
    expect(month).toMatchObject({ type: 'month', min: '2025-01', max: '2026-12', default: '2025-12', style: 'equals' });
    expect(validateRunParameterDefinitions([month])).toEqual([month]);
    expect(resolveRunParameters([month], {}).tokens).toEqual(['--date=2025-12']);
    expect(resolveRunParameters([month], { period: '2026-01' }).values.period).toBe('2026-01');
    const [separate] = validateRunParameterDefinitions([{ name: 'period', flag: '--period', type: 'month', label: 'Period' }]);
    expect(resolveRunParameters([separate], { period: '2025-12' }).tokens).toEqual(['--period', '2025-12']);

    for (const period of ['2025-13', '2025-00', '2025-1', '2025-12-01', '25-12', '-2025-12', 202512]) {
      rejects(() => resolveRunParameters([separate], { period }), /valid month \(YYYY-MM\)/, 'period');
    }
    rejects(() => resolveRunParameters([month], { period: '2024-12' }), /month range/, 'period');
    rejects(() => resolveRunParameters([month], { period: '2027-01' }), /month range/, 'period');
    rejects(() => validateRunParameterDefinitions([{ name: 'p', flag: '--p', type: 'month', label: 'P', min: '2025-01-01' }]), /invalid min month/, 'p');
    rejects(() => validateRunParameterDefinitions([{ name: 'p', flag: '--p', type: 'month', label: 'P', min: '2026-02', max: '2026-01' }]), /min month after its max month/, 'p');
    rejects(() => validateRunParameterDefinitions([{ name: 'p', flag: '--p', type: 'month', label: 'P', options: [] }]), /unsupported field options/, 'p');
  });

  it('lets a date parameter also accept a month when allow_month is set', () => {
    const [plain] = validateRunParameterDefinitions([{ name: 'date', flag: '--date', type: 'date', label: 'D' }]);
    expect(plain).not.toHaveProperty('allow_month');
    rejects(() => resolveRunParameters([plain], { date: '2026-11' }), /valid date \(YYYY-MM-DD\)$/, 'date');

    const [either] = validateRunParameterDefinitions([
      { name: 'date', flag: '--date', type: 'date', label: 'D', style: 'equals', allow_month: true, min: '2026-01-15', max: '2026-11-10', default: '2026-03' },
    ]);
    expect(either).toMatchObject({ allow_month: true, default: '2026-03' });
    expect(validateRunParameterDefinitions([either])).toEqual([either]);
    expect(resolveRunParameters([either], { date: '2026-11' }).tokens).toEqual(['--date=2026-11']);
    expect(resolveRunParameters([either], { date: '2026-11-10' }).tokens).toEqual(['--date=2026-11-10']);
    // A month counts as within the limits when any of its days is.
    expect(resolveRunParameters([either], { date: '2026-01' }).values.date).toBe('2026-01');
    rejects(() => resolveRunParameters([either], { date: '2025-12' }), /date range/, 'date');
    rejects(() => resolveRunParameters([either], { date: '2026-12' }), /date range/, 'date');
    rejects(() => resolveRunParameters([either], { date: '2026-11-11' }), /date range/, 'date');
    for (const date of ['2026-13', '2026-1', '2026-11-31', '2026']) {
      rejects(() => resolveRunParameters([either], { date }), /valid date \(YYYY-MM-DD or YYYY-MM\)/, 'date');
    }
    rejects(() => validateRunParameterDefinitions([{ name: 'd', flag: '--d', type: 'date', label: 'D', allow_month: 'yes' }]), /allow_month must be a boolean/, 'd');
    rejects(() => validateRunParameterDefinitions([{ name: 'd', flag: '--d', type: 'date', label: 'D', min: '2026-01' }]), /invalid min date/, 'd');
    rejects(() => validateRunParameterDefinitions([{ name: 'm', flag: '--m', type: 'month', label: 'M', allow_month: true }]), /unsupported field allow_month/, 'm');
    expect(validateRunParameterDefinitions([{ name: 'd', flag: '--d', type: 'date', label: 'D', allow_month: false }])[0]).not.toHaveProperty('allow_month');
  });

  it('validates integers, selects and text values without allowing argument injection', () => {
    const mixed = validateRunParameterDefinitions([
      { name: 'batch', flag: '--batch', type: 'integer', label: 'Batch', min: -5, max: 500 },
      { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', options: [{ value: 'full', label: 'Full' }] },
      { name: 'ref', flag: '--ref', type: 'text', label: 'Ref', pattern: '.*', max_length: 10 },
      { name: 'code', flag: '--code', type: 'text', label: 'Code', pattern: '[A-Z]{3}' },
    ]);
    expect(resolveRunParameters(mixed, { batch: -5 }).tokens).toEqual(['--batch', '-5']);
    rejects(() => resolveRunParameters(mixed, { batch: '10' }), /integer/, 'batch');
    rejects(() => resolveRunParameters(mixed, { batch: 1.5 }), /integer/, 'batch');
    rejects(() => resolveRunParameters(mixed, { batch: 501 }), /integer/, 'batch');
    rejects(() => resolveRunParameters(mixed, { mode: 'delta' }), /defined options/, 'mode');
    for (const ref of ['--deleteAll', '-x', 'a\nb', 'a\u0000b', 'a'.repeat(11), 42]) {
      rejects(() => resolveRunParameters(mixed, { ref }), /invalid value/, 'ref');
    }
    expect(resolveRunParameters(mixed, { ref: 'a b;$(id)' }).tokens).toEqual(['--ref', 'a b;$(id)']);
    rejects(() => resolveRunParameters(mixed, { code: 'ABCD' }), /required format/, 'code');
    rejects(() => resolveRunParameters(mixed, { code: 'abc' }), /required format/, 'code');
    expect(resolveRunParameters(mixed, { code: 'ABC' }).tokens).toEqual(['--code', 'ABC']);
  });

  it('enforces the structured execution argument limits on the composed argv', () => {
    const text = validateRunParameterDefinitions([{ name: 'ref', flag: '--ref', type: 'text', label: 'Ref', pattern: '.*' }]);
    rejects(() => resolveRunParameters(text, { ref: 'x' }, Array(99).fill('a')), /exceed/);
    expect(resolveRunParameters(text, { ref: 'x' }, Array(98).fill('a')).arguments).toHaveLength(100);
    rejects(() => resolveRunParameters(text, { ref: 'x'.repeat(256) }, Array(4).fill('a'.repeat(4000))), /exceed/);
  });

  it('does not mutate the definitions, submitted values or fixed arguments', () => {
    const submitted = { date: '2026-11-15' };
    const fixed = ['--verbose'];
    const snapshot = JSON.stringify(definitions);
    resolveRunParameters(definitions, submitted, fixed);
    expect(JSON.stringify(definitions)).toBe(snapshot);
    expect(submitted).toEqual({ date: '2026-11-15' });
    expect(fixed).toEqual(['--verbose']);
  });
});
