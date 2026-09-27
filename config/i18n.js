'use strict';

const dictionaries = {
  en: {
    pageTitle: 'Crontab UI — Scheduled tasks',
    administration: 'Administration',
    scheduledTasks: 'Scheduled tasks',
    manageDescription: 'Manage commands, schedules and publication to crontab.', newTaskDescription: 'Define the command and when it should run.',
    previewCrontab: 'Preview crontab',
    newTask: 'New task',
    environmentVariables: 'Environment variables',
    edit: 'Edit', done: 'Done',
    environmentPlaceholder: '# Define PATH, MAILTO and other required variables…', environmentEmpty: 'No environment variables defined.',
    tasks: 'Tasks',
    taskCount_one: '{count} task',
    taskCount_other: '{count} tasks',
    importExport: 'Import / Export',
    importConfiguration: 'Import configuration',
    exportConfiguration: 'Export configuration',
    getFromCrontab: 'Get from crontab',
    actions: 'Actions',
    createBackup: 'Create backup',
    publishToCrontab: 'Publish to crontab',
    name: 'Name', command: 'Command', schedule: 'Schedule', access: 'Access', lastModified: 'Last modified',
    published: 'Published', unpublishedChanges: 'Unpublished changes', publishedToService: 'Published to service crontab', localOnly: 'Local change — not published',
    owner: 'Owner', adminOnly: 'Administrator only', manageAndRun: 'Can manage and run', runOnly: 'Can run', viewOnly: 'View only', localChangesHint: 'Saving changes locally does not publish them to the service crontab.',
    run: 'Run', pause: 'Pause', activate: 'Activate', duplicate: 'Duplicate', delete: 'Delete',
    noTasks: 'There are no tasks yet',
    noTasksDescription: 'Create the first task or import an existing configuration. You can review changes before publishing them to crontab.',
    createFirstTask: 'Create first task',
    localChanges: 'Local changes', none: 'none', pendingPublication: 'pending publication',
    backups: 'Backups', noBackups: 'No backups available', openMenu: 'Open menu', language: 'Language', viewRepository: 'View repository on GitHub', switchToDarkTheme: 'Switch to dark theme', switchToLightTheme: 'Switch to light theme',
    administrator: 'Administrator', viewer: 'Viewer', operator: 'Operator', executor: 'Executor', admin: 'Administrator',
    backup: 'Backup', detail: 'Details', id: 'ID', job: 'Job', time: 'Time',
    restoreBackup: 'Restore backup', deleteBackup: 'Delete backup',
    taskOptional: 'Task name (optional)', taskNamePlaceholder: 'E.g.: Clean temporary files', status: 'Status', active: 'Active',
    commandRequired: 'Command', commandPlaceholder: '/opt/scripts/cleanup.sh', whenToRun: 'When to run',
    everyMinute: 'Every minute', everyFiveMinutes: 'Every 5 min', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', atStartup: 'At startup', paused: 'Paused',
    cronExpression: 'Cron expression', scheduleDescriptionDefault: 'Every minute, every hour, every day',
    customiseCron: 'Customise cron expression', minute: 'Minute', hour: 'Hour', day: 'Day', month: 'Month', week: 'Week', apply: 'Apply',
    logErrors: 'Log task errors', mailProfilesManaged: 'Email profiles are managed by the administrator.',
    cancel: 'Cancel', saveTask: 'Save task', close: 'Close',
    error: 'Error', operationFailed: 'Operation failed: {message}. Please see the error log for details.', auditOperationId: 'Audit operation ID: {operationId}', runComplete: 'Task run complete', runSuccess: 'The task finished. {auditOperationId}',
    deleteTaskTitle: 'Delete task', deleteTaskBody: 'This task will be removed from the application.',
    pauseTaskTitle: 'Pause task', pauseTaskBody: 'The task will no longer be included when publishing crontab.',
    activateTaskTitle: 'Activate task', activateTaskBody: 'The task will be available for publication again.',
    runTaskTitle: 'Run task', runTaskBody: 'The command will run now with the configured security limits.',
    publishTitle: 'Publish to crontab', publishBody: 'Local changes will be published to the service crontab.', publishSuccess: 'Crontab published successfully.', publicationComplete: 'Publication complete',
    getTitle: 'Get from crontab', getBody: 'A backup will be created before importing tasks from the service crontab.', import: 'Import', importSuccess: 'Tasks imported from crontab.', importComplete: 'Import complete',
    backupNoticeTitle: 'Before continuing', backupNotice: 'The backup includes the tasks and environment variables currently stored in this application.', backupDoesNotChange: 'It does not change the server crontab.', backupRestoreHint: 'You can restore this copy from Backups.',
    deleteBackupTitle: 'Delete backup', deleteBackupBody: 'This backup will be permanently removed.',
    restoreBackupTitle: 'Restore backup', restoreBackupBody: 'The current configuration will be safeguarded before this backup is restored.',
    importTitle: 'Import configuration', importBody: 'An automatic backup will be created before importing the selected configuration.', selectFile: 'Select file',
    cronLoadFailure: 'The cron expression translator could not be loaded.', cronInvalid: 'The cron expression is invalid. Check all five fields before saving.',
    cronMinuteInvalid: 'The minute field must be between 0 and 59.', cronHourInvalid: 'The hour field must be between 0 and 23.', cronDayInvalid: 'The day of month field must be between 1 and 31.', cronMonthInvalid: 'The month field must be between 1 and 12.', cronWeekInvalid: 'The day of week field must be between 0 and 6.',
    dataSearch: 'Search tasks', dataPerPage: '_MENU_ per page', dataInfo: 'Showing _START_–_END_ of _TOTAL_ tasks', dataInfoEmpty: 'No tasks', dataZero: 'No tasks found',
  },
  pt: {
    pageTitle: 'Crontab UI — Tarefas agendadas',
    administration: 'Administração', scheduledTasks: 'Tarefas agendadas', manageDescription: 'Gere os comandos, horários e a publicação no crontab.', newTaskDescription: 'Defina o comando e quando deve ser executado.', previewCrontab: 'Pré-visualizar crontab', newTask: 'Nova tarefa',
    environmentVariables: 'Variáveis de ambiente', edit: 'Editar', done: 'Concluído', environmentPlaceholder: '# Defina PATH, MAILTO e outras variáveis necessárias…', environmentEmpty: 'Não existem variáveis de ambiente definidas.',
    tasks: 'Tarefas', taskCount_one: '{count} tarefa', taskCount_other: '{count} tarefas', importExport: 'Importar / Exportar', importConfiguration: 'Importar configuração', exportConfiguration: 'Exportar configuração', getFromCrontab: 'Obter do crontab', actions: 'Acções', createBackup: 'Criar backup', publishToCrontab: 'Publicar no crontab',
    name: 'Nome', command: 'Comando', schedule: 'Horário', access: 'Acesso', lastModified: 'Última alteração', published: 'Publicado', unpublishedChanges: 'Alterações por publicar', publishedToService: 'Publicado no crontab do serviço', localOnly: 'Alteração local — não publicada', owner: 'Proprietário', adminOnly: 'Apenas administrador', manageAndRun: 'Pode gerir e executar', runOnly: 'Pode executar', viewOnly: 'Apenas consulta', localChangesHint: 'Guardar alterações localmente não as publica no crontab do serviço.', run: 'Executar', pause: 'Pausar', activate: 'Ativar', duplicate: 'Duplicar', delete: 'Apagar',
    noTasks: 'Ainda não existem tarefas', noTasksDescription: 'Crie a primeira tarefa ou importe uma configuração existente. Poderá rever as alterações antes de publicar no crontab.', createFirstTask: 'Criar primeira tarefa', localChanges: 'Alterações locais', none: 'nenhuma', pendingPublication: 'por publicar',
    backups: 'Backups', noBackups: 'Sem backups disponíveis', openMenu: 'Abrir menu', language: 'Idioma', viewRepository: 'Ver repositório no GitHub', switchToDarkTheme: 'Mudar para tema escuro', switchToLightTheme: 'Mudar para tema claro', administrator: 'Administrador', viewer: 'Consulta', operator: 'Operador', executor: 'Executor', admin: 'Administrador',
    backup: 'Backup', detail: 'Detalhe', id: 'Id', job: 'Tarefa', time: 'Horário',
    restoreBackup: 'Restaurar backup', deleteBackup: 'Apagar backup',
    taskOptional: 'Nome da tarefa (opcional)', taskNamePlaceholder: 'Ex.: Limpeza de ficheiros temporários', status: 'Estado', active: 'Ativa', commandRequired: 'Comando', commandPlaceholder: '/opt/scripts/limpeza.sh', whenToRun: 'Quando executar',
    everyMinute: 'A cada minuto', everyFiveMinutes: 'A cada 5 min', hourly: 'À hora', daily: 'Diariamente', weekly: 'Semanalmente', monthly: 'Mensalmente', yearly: 'Anualmente', atStartup: 'Ao iniciar', paused: 'Pausada', cronExpression: 'Expressão cron', scheduleDescriptionDefault: 'A cada minuto', customiseCron: 'Personalizar expressão cron', minute: 'Minuto', hour: 'Hora', day: 'Dia', month: 'Mês', week: 'Semana', apply: 'Aplicar', logErrors: 'Registar erros desta tarefa', mailProfilesManaged: 'Os perfis de e-mail são geridos pelo administrador.', cancel: 'Cancelar', saveTask: 'Guardar tarefa', close: 'Fechar',
    error: 'Erro', operationFailed: 'A operação falhou: {message}. Consulte o registo de erros para obter detalhes.', auditOperationId: 'ID da operação de auditoria: {operationId}', runComplete: 'Execução da tarefa concluída', runSuccess: 'A tarefa terminou. {auditOperationId}',
    deleteTaskTitle: 'Apagar tarefa', deleteTaskBody: 'Esta tarefa será removida da aplicação.', pauseTaskTitle: 'Pausar tarefa', pauseTaskBody: 'A tarefa deixará de ser incluída quando publicar o crontab.', activateTaskTitle: 'Ativar tarefa', activateTaskBody: 'A tarefa voltará a ficar disponível para publicação.', runTaskTitle: 'Executar tarefa', runTaskBody: 'O comando será executado agora com os limites de segurança configurados.',
    publishTitle: 'Publicar no crontab', publishBody: 'As alterações locais serão publicadas no crontab do serviço.', publishSuccess: 'Crontab publicado com sucesso.', publicationComplete: 'Publicação concluída', getTitle: 'Obter do crontab', getBody: 'Será criado um backup antes de importar as tarefas do crontab do serviço.', import: 'Importar', importSuccess: 'Tarefas importadas do crontab.', importComplete: 'Importação concluída',
    backupNoticeTitle: 'Antes de continuar', backupNotice: 'O backup inclui as tarefas e as variáveis de ambiente actualmente guardadas nesta aplicação.', backupDoesNotChange: 'Não altera o crontab do servidor.', backupRestoreHint: 'Poderá restaurar esta cópia através de Backups.', deleteBackupTitle: 'Apagar backup', deleteBackupBody: 'Esta cópia de segurança será removida de forma permanente.', restoreBackupTitle: 'Restaurar backup', restoreBackupBody: 'A configuração actual será salvaguardada antes de restaurar este backup.', importTitle: 'Importar configuração', importBody: 'Será criado um backup automático antes de importar a configuração seleccionada.', selectFile: 'Selecionar ficheiro',
    cronLoadFailure: 'Não foi possível carregar o tradutor de expressões cron.', cronInvalid: 'A expressão cron não é válida. Verifique os cinco campos antes de guardar.', cronMinuteInvalid: 'O campo minuto deve estar entre 0 e 59.', cronHourInvalid: 'O campo hora deve estar entre 0 e 23.', cronDayInvalid: 'O campo dia do mês deve estar entre 1 e 31.', cronMonthInvalid: 'O campo mês deve estar entre 1 e 12.', cronWeekInvalid: 'O campo dia da semana deve estar entre 0 e 6.',
    dataSearch: 'Pesquisar tarefas', dataPerPage: '_MENU_ por página', dataInfo: 'A mostrar _START_–_END_ de _TOTAL_ tarefas', dataInfoEmpty: 'Sem tarefas', dataZero: 'Não foram encontradas tarefas',
  },
};

function normalizeLocale(value) {
  return value === 'pt' || value === 'pt-PT' ? 'pt' : 'en';
}

function localeFromRequest(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('crontab_ui_locale='));
  return normalizeLocale(cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : 'en');
}

function translate(locale, key, values = {}) {
  const dictionary = dictionaries[normalizeLocale(locale)];
  const template = dictionary[key] || dictionaries.en[key] || key;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => String(values[name] ?? ''));
}

module.exports = { dictionaries, normalizeLocale, localeFromRequest, translate };
