'use strict';

// Parâmetros de execução manual para tarefas estruturadas (SDD v0.8.0, secção 4).
// A tarefa define os parâmetros aceites; cada execução fornece apenas valores.
// Os valores são convertidos em elementos de argv e nunca passam por shell.

const MAX_PARAMETERS = 20;
const MAX_ARGUMENTS = 100;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_TOTAL_ARGUMENT_LENGTH = 16000;
const MAX_SELECT_OPTIONS = 50;
const MAX_TEXT_LENGTH = 256;
const MAX_PATTERN_LENGTH = 256;

const ROLES = ['executor', 'operator', 'admin'];
const TYPES = ['flag', 'date', 'select', 'integer', 'text'];
const STYLES = ['separate', 'equals'];

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SELECT_VALUE = /^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const COMMON_FIELDS = ['name', 'flag', 'type', 'label', 'help', 'required', 'default', 'style', 'confirm', 'min_role'];
const TYPE_FIELDS = {
  flag: [],
  date: ['min', 'max'],
  select: ['options'],
  integer: ['min', 'max'],
  text: ['pattern', 'max_length'],
};

function parameterError(message, parameter = null) {
  return Object.assign(new Error(message), { statusCode: 422, code: 'INVALID_RUN_PARAMETERS', parameter });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedText(value, maximum, { required }) {
  if (value === undefined || value === null) return !required;
  return typeof value === 'string' && value.length <= maximum && !CONTROL.test(value)
    && (!required || value.trim().length > 0);
}

function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function compileTextPattern(pattern, name) {
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > MAX_PATTERN_LENGTH) {
    throw parameterError(`Parameter ${name} requires a pattern of up to ${MAX_PATTERN_LENGTH} characters`, name);
  }
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch (_error) {
    throw parameterError(`Parameter ${name} has an invalid pattern`, name);
  }
}

function isEmpty(value) {
  return value === null || value === '';
}

// Valida um valor não vazio de acordo com o tipo do parâmetro (já normalizado).
function checkValue(definition, value) {
  const { name, type } = definition;
  switch (type) {
    case 'flag':
      if (typeof value !== 'boolean') throw parameterError(`Parameter ${name} must be true or false`, name);
      return value;
    case 'date':
      if (!isCalendarDate(value)) throw parameterError(`Parameter ${name} must be a valid date (YYYY-MM-DD)`, name);
      if ((definition.min && value < definition.min) || (definition.max && value > definition.max)) {
        throw parameterError(`Parameter ${name} is outside the allowed date range`, name);
      }
      return value;
    case 'select':
      if (typeof value !== 'string' || !definition.options.some((option) => option.value === value)) {
        throw parameterError(`Parameter ${name} must be one of the defined options`, name);
      }
      return value;
    case 'integer':
      if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) {
        throw parameterError(`Parameter ${name} must be an integer between ${definition.min} and ${definition.max}`, name);
      }
      return value;
    case 'text': {
      if (typeof value !== 'string' || value.length > definition.max_length || CONTROL.test(value) || value.startsWith('-')) {
        throw parameterError(`Parameter ${name} contains an invalid value`, name);
      }
      if (!compileTextPattern(definition.pattern, name).test(value)) {
        throw parameterError(`Parameter ${name} does not match the required format`, name);
      }
      return value;
    }
    default:
      throw parameterError(`Parameter ${name} has an unsupported type`, name);
  }
}

function normalizeTypeFields(raw, normalized) {
  const { name, type } = normalized;
  if (type === 'date') {
    for (const bound of ['min', 'max']) {
      if (raw[bound] !== undefined && raw[bound] !== null) {
        if (!isCalendarDate(raw[bound])) throw parameterError(`Parameter ${name} has an invalid ${bound} date`, name);
        normalized[bound] = raw[bound];
      } else {
        normalized[bound] = null;
      }
    }
    if (normalized.min && normalized.max && normalized.min > normalized.max) {
      throw parameterError(`Parameter ${name} has a min date after its max date`, name);
    }
  } else if (type === 'integer') {
    if (!Number.isSafeInteger(raw.min) || !Number.isSafeInteger(raw.max) || raw.min > raw.max) {
      throw parameterError(`Parameter ${name} requires integer min and max with min <= max`, name);
    }
    normalized.min = raw.min;
    normalized.max = raw.max;
  } else if (type === 'select') {
    if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > MAX_SELECT_OPTIONS) {
      throw parameterError(`Parameter ${name} requires between 1 and ${MAX_SELECT_OPTIONS} options`, name);
    }
    const seen = new Set();
    normalized.options = raw.options.map((option) => {
      if (!isPlainObject(option) || Object.keys(option).some((key) => key !== 'value' && key !== 'label')
        || typeof option.value !== 'string' || !SELECT_VALUE.test(option.value)
        || !boundedText(option.label, 80, { required: true })) {
        throw parameterError(`Parameter ${name} has an invalid option`, name);
      }
      if (seen.has(option.value)) throw parameterError(`Parameter ${name} has duplicate option values`, name);
      seen.add(option.value);
      return { value: option.value, label: option.label };
    });
  } else if (type === 'text') {
    compileTextPattern(raw.pattern, name);
    normalized.pattern = raw.pattern;
    const maximum = raw.max_length === undefined ? MAX_TEXT_LENGTH : raw.max_length;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_TEXT_LENGTH) {
      throw parameterError(`Parameter ${name} max_length must be between 1 and ${MAX_TEXT_LENGTH}`, name);
    }
    normalized.max_length = maximum;
  }
}

function collidesWithFixedArgument(flag, fixedArguments) {
  return fixedArguments.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}

function validateRunParameterDefinitions(definitions, fixedArguments = []) {
  if (definitions === undefined || definitions === null) return [];
  if (!Array.isArray(definitions) || definitions.length > MAX_PARAMETERS) {
    throw parameterError(`Run parameters must be a list of up to ${MAX_PARAMETERS} definitions`);
  }
  const names = new Set();
  const flags = new Set();
  return definitions.map((raw) => {
    if (!isPlainObject(raw)) throw parameterError('Run parameter definition must be an object');
    const name = raw.name;
    if (typeof name !== 'string' || !NAME.test(name)) throw parameterError('Run parameter name is invalid');
    if (names.has(name)) throw parameterError(`Run parameter ${name} is defined more than once`, name);
    names.add(name);
    if (!TYPES.includes(raw.type)) throw parameterError(`Parameter ${name} has an unsupported type`, name);
    const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[raw.type]]);
    const unknown = Object.keys(raw).find((key) => !allowed.has(key));
    if (unknown) throw parameterError(`Parameter ${name} contains unsupported field ${unknown}`, name);

    if (typeof raw.flag !== 'string' || !FLAG.test(raw.flag)) throw parameterError(`Parameter ${name} has an invalid flag`, name);
    if (flags.has(raw.flag)) throw parameterError(`Flag ${raw.flag} is used by more than one parameter`, name);
    if (collidesWithFixedArgument(raw.flag, fixedArguments)) {
      throw parameterError(`Flag ${raw.flag} is already present in the fixed arguments`, name);
    }
    flags.add(raw.flag);

    if (!boundedText(raw.label, 80, { required: true })) throw parameterError(`Parameter ${name} requires a label of up to 80 characters`, name);
    if (!boundedText(raw.help, 200, { required: false })) throw parameterError(`Parameter ${name} help must have up to 200 characters`, name);
    for (const field of ['required', 'confirm']) {
      if (raw[field] !== undefined && typeof raw[field] !== 'boolean') throw parameterError(`Parameter ${name} ${field} must be a boolean`, name);
    }
    if (raw.min_role !== undefined && !ROLES.includes(raw.min_role)) throw parameterError(`Parameter ${name} has an invalid min_role`, name);

    const isFlag = raw.type === 'flag';
    // Normalised definitions store required: false on flags, so re-validating them stays idempotent.
    if (isFlag && raw.required === true) throw parameterError(`Flag parameter ${name} cannot be required`, name);
    if (isFlag && raw.style !== undefined) throw parameterError(`Flag parameter ${name} cannot define a style`, name);
    if (!isFlag && raw.style !== undefined && !STYLES.includes(raw.style)) throw parameterError(`Parameter ${name} has an invalid style`, name);

    const normalized = {
      name,
      flag: raw.flag,
      type: raw.type,
      label: raw.label,
      help: raw.help || null,
      required: Boolean(raw.required),
      confirm: Boolean(raw.confirm),
      min_role: raw.min_role || 'executor',
    };
    if (!isFlag) normalized.style = raw.style || 'separate';
    normalizeTypeFields(raw, normalized);

    if (isFlag) {
      normalized.default = raw.default === undefined ? false : checkValue(normalized, raw.default);
    } else if (raw.default === undefined || isEmpty(raw.default)) {
      normalized.default = null;
    } else {
      normalized.default = checkValue(normalized, raw.default);
    }
    return normalized;
  });
}

function tokensFor(definition, value) {
  if (definition.type === 'flag') return value ? [definition.flag] : [];
  const text = String(value);
  return definition.style === 'equals' ? [`${definition.flag}=${text}`] : [definition.flag, text];
}

function assertArgumentLimits(args) {
  if (args.length > MAX_ARGUMENTS
    || args.some((argument) => argument.length > MAX_ARGUMENT_LENGTH)
    || args.reduce((total, argument) => total + argument.length, 0) > MAX_TOTAL_ARGUMENT_LENGTH) {
    throw parameterError('The composed arguments exceed the structured execution limits');
  }
}

// Recebe definições normalizadas por validateRunParameterDefinitions.
// Devolve os valores activos, os tokens emitidos, os requisitos de cada parâmetro activo
// e o argv composto (argumentos fixos seguidos dos tokens, pela ordem da definição).
function resolveRunParameters(definitions, submitted, fixedArguments = []) {
  const values = submitted === undefined || submitted === null ? {} : submitted;
  if (!isPlainObject(values)) throw parameterError('Run parameter values must be an object');
  const known = new Set(definitions.map((definition) => definition.name));
  const unknown = Object.keys(values).find((key) => !known.has(key));
  if (unknown) throw parameterError(`Unknown run parameter ${unknown}`, unknown);

  const resolved = { values: {}, tokens: [], active: [] };
  for (const definition of definitions) {
    const value = Object.hasOwn(values, definition.name) ? values[definition.name] : definition.default;
    if (definition.type !== 'flag' && (value === undefined || isEmpty(value))) {
      if (definition.required) throw parameterError(`Parameter ${definition.name} is required`, definition.name);
      continue;
    }
    const checked = checkValue(definition, value);
    const tokens = tokensFor(definition, checked);
    if (!tokens.length) continue;
    resolved.values[definition.name] = checked;
    resolved.tokens.push(...tokens);
    resolved.active.push({ name: definition.name, confirm: definition.confirm, min_role: definition.min_role });
  }
  resolved.arguments = [...fixedArguments, ...resolved.tokens];
  assertArgumentLimits(resolved.arguments);
  return resolved;
}

module.exports = {
  MAX_PARAMETERS,
  NAME_PATTERN: NAME,
  ROLES,
  TYPES,
  resolveRunParameters,
  validateRunParameterDefinitions,
};
