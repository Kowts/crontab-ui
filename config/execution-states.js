'use strict';

// Formalização dos estados de execução e transições permitidas.
// Referência: Roadmap v0.6.0, Secção 4 — Fiabilidade das execuções e recuperação de falhas.

const EXECUTION_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
  OUTPUT_LIMIT: 'output_limit',
});

const ALL_STATES = Object.freeze(Object.values(EXECUTION_STATES));

// Estados terminais: uma vez atingidos, não podem ser alterados.
const TERMINAL_STATES = Object.freeze([
  EXECUTION_STATES.SUCCESS,
  EXECUTION_STATES.FAILED,
  EXECUTION_STATES.TIMEOUT,
  EXECUTION_STATES.CANCELLED,
  EXECUTION_STATES.INTERRUPTED,
  EXECUTION_STATES.OUTPUT_LIMIT,
]);

// Transições permitidas: de cada estado, para quais estados se pode transitar.
const ALLOWED_TRANSITIONS = Object.freeze({
  [EXECUTION_STATES.PENDING]: [EXECUTION_STATES.RUNNING, EXECUTION_STATES.CANCELLED, EXECUTION_STATES.INTERRUPTED],
  [EXECUTION_STATES.RUNNING]: [
    EXECUTION_STATES.SUCCESS,
    EXECUTION_STATES.FAILED,
    EXECUTION_STATES.TIMEOUT,
    EXECUTION_STATES.CANCELLED,
    EXECUTION_STATES.INTERRUPTED,
    EXECUTION_STATES.OUTPUT_LIMIT,
  ],
  // Estados terminais não permitem transições.
  [EXECUTION_STATES.SUCCESS]: [],
  [EXECUTION_STATES.FAILED]: [],
  [EXECUTION_STATES.TIMEOUT]: [],
  [EXECUTION_STATES.CANCELLED]: [],
  [EXECUTION_STATES.INTERRUPTED]: [],
  [EXECUTION_STATES.OUTPUT_LIMIT]: [],
});

function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

function isValidState(state) {
  return ALL_STATES.includes(state);
}

function isValidTransition(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) return false;
  if (fromState === toState) return false;
  return (ALLOWED_TRANSITIONS[fromState] || []).includes(toState);
}

function resolveTerminalState(error, result) {
  if (!result) return null;
  if (result.terminationReason === 'cancelled') return EXECUTION_STATES.CANCELLED;
  if (result.terminationReason === 'timeout') return EXECUTION_STATES.TIMEOUT;
  if (result.terminationReason === 'output_limit') return EXECUTION_STATES.OUTPUT_LIMIT;
  if (error) return EXECUTION_STATES.FAILED;
  if (result.exitCode === 0) return EXECUTION_STATES.SUCCESS;
  return EXECUTION_STATES.FAILED;
}

function canTransition(fromState, toState) {
  if (isTerminalState(fromState)) return false;
  return isValidTransition(fromState, toState);
}

module.exports = {
  EXECUTION_STATES,
  ALL_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  isTerminalState,
  isValidState,
  isValidTransition,
  canTransition,
  resolveTerminalState,
};
