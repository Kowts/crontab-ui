'use strict';

// Em produção a aplicação nunca deve executar como root. Um processo root
// poderia ler ficheiros sensíveis, escrever fora dos volumes previstos e
// comprometer o isolamento das tarefas agendadas. Esta validação é executada
// no arranque e rejeita configurações inseguras antes de expôr o serviço.

function validateProductionPrivileges({ nodeEnv } = {}) {
  if (nodeEnv !== 'production') return;

  // process.getuid não existe no Windows; a verificação de root só se aplica
  // a sistemas POSIX onde o conceito de utilizador privilegiado é relevante.
  if (typeof process.getuid !== 'function') return;

  if (process.getuid() === 0) {
    throw new Error(
      'Crontab UI must not run as root in production. ' +
      'Run the service as a dedicated non-privileged user (e.g. node).'
    );
  }
}

module.exports = { validateProductionPrivileges };
