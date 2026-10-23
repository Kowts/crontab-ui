'use strict';

const fs = require('fs');

// Em produção os ficheiros de base de dados e logs não devem ser acessíveis por
// utilizadores além do proprietário do serviço. Permissões demasiado abertas
// permitem que outros utilizadores do mesmo host leiam ou alterem tarefas,
// históricos de execução e auditoria. Esta validação é executada no arranque
// e rejeita configurações inseguras antes de expôr o serviço.

const MAX_DIR_MODE = 0o700; // apenas o proprietário pode ler/escrever/executar
const MAX_FILE_MODE = 0o600; // apenas o proprietário pode ler/escrever

function modeIsTooOpen(mode, maxMode) {
  return (mode & ~maxMode) !== 0;
}

function validateFilePermissions({ nodeEnv, dbFolder, logFolder, dbFile } = {}) {
  if (nodeEnv !== 'production') return;

  // process.chmod / fs.stat modos não são relevantes no Windows; a verificação
  // de permissões POSIX só se aplica a sistemas que a suportam.
  if (typeof process.getuid !== 'function') return;

  const checkPath = (label, filePath, maxMode) => {
    try {
      const stat = fs.statSync(filePath);
      const mode = stat.mode & 0o777;
      if (modeIsTooOpen(mode, maxMode)) {
        throw new Error(
          `${label} ('${filePath}') has overly open permissions (${mode.toString(8)}). ` +
          `Expected no more than ${maxMode.toString(8)} for the owner only.`
        );
      }
    } catch (error) {
      if (error.code === 'ENOENT') return; // ainda não existe; será criado com modo restrito
      throw error;
    }
  };

  checkPath('Database directory', dbFolder, MAX_DIR_MODE, true);
  checkPath('Log directory', logFolder, MAX_DIR_MODE, true);
  if (dbFile) checkPath('Database file', dbFile, MAX_FILE_MODE, false);
}

module.exports = { validateFilePermissions, MAX_DIR_MODE, MAX_FILE_MODE };
