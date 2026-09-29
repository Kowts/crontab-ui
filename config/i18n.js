'use strict';

const dictionaries = {
  en: {
    loginRateLimited: 'Too many sign-in attempts. Try again in {minutes} minutes.', invalidCredentials: 'Invalid username or password.',
    logout: 'Sign out', signIn: 'Sign in', signInDescription: 'Enter your account credentials to manage scheduled tasks.', username: 'Username', password: 'Password',
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
    testMailProfile: 'Test mail profile',
    testMailProfileTitle: 'Test mail profile',
    testMailProfileDescription: 'Sends a test message to the recipients already defined by the profile. Credentials are never shown or sent from the browser.',
    testMailProfileNone: 'No mail profiles are configured.',
    testMailProfileRun: 'Send test',
    testMailProfileSending: 'Sending test message…',
    testMailProfileSent: 'The test message was delivered to the profile recipients.',
    testMailProfileFailed: 'The test message could not be delivered.',
    testMailProfileError_auth_failed: 'The SMTP server rejected the credentials.',
    testMailProfileError_tls: 'The TLS negotiation with the SMTP server failed.',
    testMailProfileError_dns: 'The SMTP server host could not be resolved.',
    testMailProfileError_refused: 'The connection to the SMTP server was refused or dropped.',
    testMailProfileError_timeout: 'The SMTP server did not respond in time.',
    testMailProfileError_rejected: 'The SMTP server rejected the message or the recipients.',
    testMailProfileError_unavailable: 'The SMTP server could not be reached.',
    testMailProfileError_throttled: 'A test was already sent for this profile. Try again shortly.',
    mailProfileDetail: 'Check the operation log for the server detail of this test.',
    name: 'Name', command: 'Command', schedule: 'Schedule', access: 'Access', lastModified: 'Last modified',
    published: 'Published', unpublishedChanges: 'Unpublished changes', publishedToService: 'Published to service crontab', localOnly: 'Local change — not published',
    owner: 'Owner', adminOnly: 'Administrator only', manageAndRun: 'Can manage and run', runOnly: 'Can run', viewOnly: 'View only', localChangesHint: 'Saving changes locally does not publish them to the service crontab.',
    run: 'Run', pause: 'Disable', enable: 'Enable', runNow: 'Run now without publishing', disableSchedule: 'Disable scheduled task', enableSchedule: 'Enable scheduled task', stopExecution: 'Stop execution', duplicate: 'Duplicate', delete: 'Delete', viewErrorLog: 'View error log', viewOutputLog: 'View standard output log', reviewAndPublish: 'Review and publish',
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
    everyMinute: 'Every minute', everyFiveMinutes: 'Every 5 min', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', atStartup: 'At startup', disabled: 'Disabled',
    cronExpression: 'Cron expression', scheduleDescriptionDefault: 'Every minute, every hour, every day',
    customiseCron: 'Customise cron expression', minute: 'Minute', hour: 'Hour', day: 'Day', month: 'Month', week: 'Week', apply: 'Apply',
    logErrors: 'Log task errors', emailNotification: 'Email notification', noEmailNotification: 'No email notification', emailNotificationPolicy: 'Notification policy', notifyOnFailure: 'Only on failure', notifyOnSuccess: 'Only on success', notifyAlways: 'Always', mailProfilesManaged: 'Email profiles are managed by the administrator.',
    cancel: 'Cancel', saveTask: 'Save task', close: 'Close',
    error: 'Error', operationFailed: 'Operation failed: {message}. Please see the error log for details.', auditOperationId: 'Audit operation ID: {operationId}', runComplete: 'Task run complete', runSuccess: 'The task finished. {auditOperationId}', runStopped: 'The task execution was stopped. {auditOperationId}', runFailed: 'The task execution did not complete. {auditOperationId}',
    deleteTaskTitle: 'Delete task', deleteTaskBody: 'This task will be removed from the application.',
    disableScheduleTitle: 'Disable scheduled task', disableScheduleBody: 'The task will no longer be included when publishing crontab.',
    enableScheduleTitle: 'Enable scheduled task', enableScheduleBody: 'The task will be available for publication again.',
    runTaskTitle: 'Run task', runTaskBody: 'The command will run now with the configured security limits.',
    publishTitle: 'Publish to crontab', publishBody: 'Local changes will be published to the service crontab.', publishSuccess: 'Crontab published successfully.', publicationComplete: 'Publication complete',
    getTitle: 'Get from crontab', getBody: 'A backup will be created before importing tasks from the service crontab.', import: 'Import', importSuccess: 'Tasks imported from crontab.', importComplete: 'Import complete',
    backupNoticeTitle: 'Before continuing', backupNotice: 'The backup includes the tasks and environment variables currently stored in this application.', backupDoesNotChange: 'It does not change the server crontab.', backupRestoreHint: 'You can restore this copy from Backups.',
    deleteBackupTitle: 'Delete backup', deleteBackupBody: 'This backup will be permanently removed.',
    restoreBackupTitle: 'Restore backup', restoreBackupBody: 'The current configuration will be safeguarded before this backup is restored.',
    importTitle: 'Import configuration', importBody: 'An automatic backup will be created before applying the selected configuration.', selectFile: 'Select file', importMode: 'Import mode', importMerge: 'Merge with existing tasks (recommended)', importMergeHint: 'Existing tasks are kept. Exact duplicates are skipped.', importReplace: 'Replace all existing tasks', importReplaceHint: 'This removes the current task list after creating an automatic backup.', reviewImport: 'Review import', importPreviewTitle: 'Review import', importPreviewBody: 'Confirm the changes before modifying the current configuration.', existingTasks: 'Existing tasks', incomingTasks: 'Tasks in file', importAdditions: 'Tasks to add', importDuplicates: 'Duplicates to skip', importConflicts: 'Same-name conflicts', importReplaced: 'Tasks to replace', importConfirmMerge: 'Merge tasks', importConfirmReplace: 'Replace tasks', importApplied: 'Import applied',
    cronLoadFailure: 'The cron expression translator could not be loaded.', cronInvalid: 'The cron expression is invalid. Check all five fields before saving.',
    cronMinuteInvalid: 'The minute field must be between 0 and 59.', cronHourInvalid: 'The hour field must be between 0 and 23.', cronDayInvalid: 'The day of month field must be between 1 and 31.', cronMonthInvalid: 'The month field must be between 1 and 12.', cronWeekInvalid: 'The day of week field must be between 0 and 6.',
    dataSearch: 'Search tasks', dataPerPage: '_MENU_ per page', dataInfo: 'Showing _START_–_END_ of _TOTAL_ tasks', dataInfoEmpty: 'No tasks', dataZero: 'No tasks found',
  },
  pt: {
    loginRateLimited: 'Demasiadas tentativas de início de sessão. Tente novamente dentro de {minutes} minutos.', invalidCredentials: 'Utilizador ou palavra-passe inválidos.',
    logout: 'Terminar sessão', signIn: 'Iniciar sessão', signInDescription: 'Introduza as credenciais da sua conta para gerir as tarefas agendadas.', username: 'Utilizador', password: 'Palavra-passe',
    pageTitle: 'Crontab UI — Tarefas agendadas',
    administration: 'Administração', scheduledTasks: 'Tarefas agendadas', manageDescription: 'Gere os comandos, horários e a publicação no crontab.', newTaskDescription: 'Defina o comando e quando deve ser executado.', previewCrontab: 'Pré-visualizar crontab', newTask: 'Nova tarefa',
    environmentVariables: 'Variáveis de ambiente', edit: 'Editar', done: 'Concluído', environmentPlaceholder: '# Defina PATH, MAILTO e outras variáveis necessárias…', environmentEmpty: 'Não existem variáveis de ambiente definidas.',
    tasks: 'Tarefas', taskCount_one: '{count} tarefa', taskCount_other: '{count} tarefas', importExport: 'Importar / Exportar', importConfiguration: 'Importar configuração', exportConfiguration: 'Exportar configuração', getFromCrontab: 'Obter do crontab', actions: 'Acções', createBackup: 'Criar backup', publishToCrontab: 'Publicar no crontab', testMailProfile: 'Testar perfil de correio', testMailProfileTitle: 'Testar perfil de correio', testMailProfileDescription: 'Envia uma mensagem de teste para os destinatários já definidos no perfil. As credenciais nunca são apresentadas nem enviadas pelo browser.', testMailProfileNone: 'Não existem perfis de correio configurados.', testMailProfileRun: 'Enviar teste', testMailProfileSending: 'A enviar mensagem de teste…', testMailProfileSent: 'A mensagem de teste foi entregue aos destinatários do perfil.', testMailProfileFailed: 'Não foi possível entregar a mensagem de teste.', testMailProfileError_auth_failed: 'O servidor SMTP rejeitou as credenciais.', testMailProfileError_tls: 'A negociação TLS com o servidor SMTP falhou.', testMailProfileError_dns: 'Não foi possível resolver o host do servidor SMTP.', testMailProfileError_refused: 'A ligação ao servidor SMTP foi recusada ou interrompida.', testMailProfileError_timeout: 'O servidor SMTP não respondeu a tempo.', testMailProfileError_rejected: 'O servidor SMTP rejeitou a mensagem ou os destinatários.', testMailProfileError_unavailable: 'Não foi possível contactar o servidor SMTP.', testMailProfileError_throttled: 'Já foi enviado um teste para este perfil. Tente novamente dentro de pouco tempo.', mailProfileDetail: 'Consulte o diário de operações para ver o detalhe do servidor sobre este teste.',
    name: 'Nome', command: 'Comando', schedule: 'Horário', access: 'Acesso', lastModified: 'Última alteração', published: 'Publicado', unpublishedChanges: 'Alterações por publicar', publishedToService: 'Publicado no crontab do serviço', localOnly: 'Alteração local — não publicada', owner: 'Proprietário', adminOnly: 'Apenas administrador', manageAndRun: 'Pode gerir e executar', runOnly: 'Pode executar', viewOnly: 'Apenas consulta', localChangesHint: 'Guardar alterações localmente não as publica no crontab do serviço.', run: 'Executar', pause: 'Pausar', enable: 'Ativar', runNow: 'Executar agora sem publicar', disableSchedule: 'Desativar tarefa agendada', enableSchedule: 'Ativar tarefa agendada', stopExecution: 'Parar execução', duplicate: 'Duplicar', delete: 'Apagar', viewErrorLog: 'Ver registo de erros', viewOutputLog: 'Ver registo de saída padrão', reviewAndPublish: 'Rever e publicar',
    noTasks: 'Ainda não existem tarefas', noTasksDescription: 'Crie a primeira tarefa ou importe uma configuração existente. Poderá rever as alterações antes de publicar no crontab.', createFirstTask: 'Criar primeira tarefa', localChanges: 'Alterações locais', none: 'nenhuma', pendingPublication: 'por publicar',
    backups: 'Backups', noBackups: 'Sem backups disponíveis', openMenu: 'Abrir menu', language: 'Idioma', viewRepository: 'Ver repositório no GitHub', switchToDarkTheme: 'Mudar para tema escuro', switchToLightTheme: 'Mudar para tema claro', administrator: 'Administrador', viewer: 'Consulta', operator: 'Operador', executor: 'Executor', admin: 'Administrador',
    backup: 'Backup', detail: 'Detalhe', id: 'Id', job: 'Tarefa', time: 'Horário',
    restoreBackup: 'Restaurar backup', deleteBackup: 'Apagar backup',
    taskOptional: 'Nome da tarefa (opcional)', taskNamePlaceholder: 'Ex.: Limpeza de ficheiros temporários', status: 'Estado', active: 'Ativa', commandRequired: 'Comando', commandPlaceholder: '/opt/scripts/limpeza.sh', whenToRun: 'Quando executar',
    everyMinute: 'A cada minuto', everyFiveMinutes: 'A cada 5 min', hourly: 'À hora', daily: 'Diariamente', weekly: 'Semanalmente', monthly: 'Mensalmente', yearly: 'Anualmente', atStartup: 'Ao iniciar', disabled: 'Desativada', cronExpression: 'Expressão cron', scheduleDescriptionDefault: 'A cada minuto', customiseCron: 'Personalizar expressão cron', minute: 'Minuto', hour: 'Hora', day: 'Dia', month: 'Mês', week: 'Semana', apply: 'Aplicar', logErrors: 'Registar erros da tarefa', emailNotification: 'Notificação por e-mail', noEmailNotification: 'Sem notificação por e-mail', emailNotificationPolicy: 'Política de notificação', notifyOnFailure: 'Apenas em falha', notifyOnSuccess: 'Apenas em sucesso', notifyAlways: 'Sempre', mailProfilesManaged: 'Os perfis de e-mail são geridos pelo administrador.', cancel: 'Cancelar', saveTask: 'Guardar tarefa', close: 'Fechar',
    error: 'Erro', operationFailed: 'A operação falhou: {message}. Consulte o registo de erros para obter detalhes.', auditOperationId: 'ID da operação de auditoria: {operationId}', runComplete: 'Execução da tarefa concluída', runSuccess: 'A tarefa terminou. {auditOperationId}', runStopped: 'A execução da tarefa foi parada. {auditOperationId}', runFailed: 'A execução da tarefa não foi concluída. {auditOperationId}',
    deleteTaskTitle: 'Apagar tarefa', deleteTaskBody: 'Esta tarefa será removida da aplicação.', disableScheduleTitle: 'Desativar tarefa agendada', disableScheduleBody: 'A tarefa deixará de ser incluída quando publicar o crontab.', enableScheduleTitle: 'Ativar tarefa agendada', enableScheduleBody: 'A tarefa voltará a ficar disponível para publicação.', runTaskTitle: 'Executar tarefa', runTaskBody: 'O comando será executado agora com os limites de segurança configurados.',
    publishTitle: 'Publicar no crontab', publishBody: 'As alterações locais serão publicadas no crontab do serviço.', publishSuccess: 'Crontab publicado com sucesso.', publicationComplete: 'Publicação concluída', getTitle: 'Obter do crontab', getBody: 'Será criado um backup antes de importar as tarefas do crontab do serviço.', import: 'Importar', importSuccess: 'Tarefas importadas do crontab.', importComplete: 'Importação concluída',
    backupNoticeTitle: 'Antes de continuar', backupNotice: 'O backup inclui as tarefas e as variáveis de ambiente actualmente guardadas nesta aplicação.', backupDoesNotChange: 'Não altera o crontab do servidor.', backupRestoreHint: 'Poderá restaurar esta cópia através de Backups.', deleteBackupTitle: 'Apagar backup', deleteBackupBody: 'Esta cópia de segurança será removida de forma permanente.', restoreBackupTitle: 'Restaurar backup', restoreBackupBody: 'A configuração actual será salvaguardada antes de restaurar este backup.', importTitle: 'Importar configuração', importBody: 'Será criado um backup automático antes de aplicar a configuração selecionada.', selectFile: 'Selecionar ficheiro', importMode: 'Modo de importação', importMerge: 'Combinar com as tarefas existentes (recomendado)', importMergeHint: 'As tarefas existentes são mantidas. Os duplicados exatos são ignorados.', importReplace: 'Substituir todas as tarefas existentes', importReplaceHint: 'Remove a lista atual de tarefas depois de criar um backup automático.', reviewImport: 'Rever importação', importPreviewTitle: 'Rever importação', importPreviewBody: 'Confirme as alterações antes de modificar a configuração atual.', existingTasks: 'Tarefas existentes', incomingTasks: 'Tarefas no ficheiro', importAdditions: 'Tarefas a adicionar', importDuplicates: 'Duplicados a ignorar', importConflicts: 'Conflitos de nome', importReplaced: 'Tarefas a substituir', importConfirmMerge: 'Combinar tarefas', importConfirmReplace: 'Substituir tarefas', importApplied: 'Importação aplicada',
    cronLoadFailure: 'Não foi possível carregar o tradutor de expressões cron.', cronInvalid: 'A expressão cron não é válida. Verifique os cinco campos antes de guardar.', cronMinuteInvalid: 'O campo minuto deve estar entre 0 e 59.', cronHourInvalid: 'O campo hora deve estar entre 0 e 23.', cronDayInvalid: 'O campo dia do mês deve estar entre 1 e 31.', cronMonthInvalid: 'O campo mês deve estar entre 1 e 12.', cronWeekInvalid: 'O campo dia da semana deve estar entre 0 e 6.',
    dataSearch: 'Pesquisar tarefas', dataPerPage: '_MENU_ por página', dataInfo: 'A mostrar _START_–_END_ de _TOTAL_ tarefas', dataInfoEmpty: 'Sem tarefas', dataZero: 'Não foram encontradas tarefas',
  },
};

// Keep the label aligned with the scheduled-task state: this action disables
// publication of the task rather than merely pausing a running process.
dictionaries.en.pause = 'Disable';
dictionaries.pt.pause = 'Desativar';

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
