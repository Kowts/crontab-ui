# Release notes

## 0.5.2

### Correcção do timeout agendado

- Cada comando agendado publicado inclui agora `COMMAND_TIMEOUT_MS` com o valor
  efectivo do serviço. O runner deixa de depender da herança do ambiente do cron
  para receber o timeout configurado.
- Docker Compose transmite `COMMAND_TIMEOUT_MS`; a allowlist predefinida também
  inclui esta variável no ambiente restrito do scheduler.
- `COMMAND_TIMEOUT_MS=0` desactiva o timeout das tarefas, mantendo o cancelamento
  e o limite de output. A publicação mantém um timeout limitado.
- A tag `v0.5.1` não inclui estas correcções. A versão `0.5.2` distingue o código
  corrigido, incluindo o commit `7546a82`, da release anterior.

### Base de dados dos runners agendados

- Cada comando publicado transmite `CRON_DB_PATH` como caminho absoluto, evitando
  que o runner abra a base predefinida da instalação em vez da base do serviço.
- Caminhos com espaços, apóstrofos e caracteres especiais mantêm o quoting da
  shell; o escape de percentagens respeita a diferença entre cron nativo e Docker.
- Caminhos com quebras de linha ou bytes nulos são rejeitados no arranque.
- A alteração aplica-se após reiniciar o serviço actualizado e publicar novamente
  a agenda. Não move nem combina bases de dados anteriormente separadas.

### Actualização obrigatória

- A recuperação de execuções manuais fica limitada ao arranque de `bootstrap.js`.
  O arranque de um runner agendado deixa de marcar execuções manuais activas como
  interrompidas, preservando também o limite de concorrência por utilizador.
- O diálogo de execução distingue interrupção por recuperação de uma conclusão
  normal, com título de erro e mensagem específica em PT/EN.

- O diagnóstico distingue a agenda pretendida da instalada e abre na instalada.
  A confirmação Docker exige o hash reconhecido pelo Supercronic; falhas de leitura
  não são ocultadas por um preview regenerado.
- Histórico e auditoria registam timeout efectivo, versão, host, PID e hash do
  executor. Os testes verificam processos novos, timeout zero e integração Docker
  com base personalizada, sucesso e terminação real por timeout.

- Instale a versão corrigida e reinicie o serviço com a configuração de produção.
  No Docker Compose, recrie o contentor com a imagem reconstruída e o ficheiro de
  ambiente correcto; reiniciar apenas o contentor não actualiza o seu ambiente.
- Publique novamente o crontab pela aplicação. Agendas existentes não são
  actualizadas automaticamente quando o código ou a configuração mudam.
- Confirme na agenda efectivamente instalada que os comandos contêm o valor
  pretendido, por exemplo `COMMAND_TIMEOUT_MS=7200000` para duas horas. O preview
  da aplicação não comprova o conteúdo da agenda instalada.
- A SQLite recebe uma migração aditiva e transaccional para metadados opcionais.
  Os registos históricos permanecem inalterados e sem metadados presumidos; valide
  o resultado numa nova execução.

### Estado da release

- Validação local final: 245 testes aprovados, cobertura de linhas de 84,93% com
  todos os limiares cumpridos, lint e diagnósticos do editor sem erros.
- Regressão adicional confirma que um runner agendado não interrompe uma execução
  manual activa nem remove o bloqueio por utilizador; recuperação no bootstrap e
  mensagem de interrupção cobertas em PT/EN, com confirmação em browser PT.
- Integração Docker real aprovada: build, publicação, hash de recarga confirmado,
  tarefas como UID 1000, base personalizada e timeout efectivo de 5000 ms, com
  sucesso e terminação por timeout registados no histórico.
- Runners novos testados com caminhos especiais e timeout zero; histórico antigo
  preservado pela migração. A variante nativa POSIX dos testes fica para o CI Linux.
- Interface verificada em browser em desktop/mobile, com agenda instalada distinta
  da pretendida e metadados no histórico; selector de agenda confirmado em PT/EN.
- Versão preparada localmente; publicação, tag `v0.5.2` e validação do CI ainda
  pendentes. A tag `v0.5.1` deve permanecer inalterada.

## 0.5.1

### Destaques

- Excepção explícita de HTTP em produção através de `ALLOW_HTTP=true`, sem mudar
  `NODE_ENV` nem simular um proxy HTTPS. Apenas o valor exacto `true` activa a opção;
  HTTPS continua obrigatório por omissão.
- A opção é aplicada na validação de arranque e em cada pedido. Os cookies de sessão
  e CSRF deixam de exigir Secure, e HSTS e a promoção para HTTPS pela CSP são
  desactivados, permitindo o login e a operação por HTTP.
- Autenticação, RBAC, validação CSRF e a obrigatoriedade de `CSRF_SECRET` em produção
  permanecem inalterados. Configurações de proxy inválidas e o bypass de autenticação
  em produção continuam a ser rejeitados.
- Docker Compose transmite `ALLOW_HTTP` com predefinição `false`. Os exemplos e os
  READMEs bilingues documentam a configuração, os limites de acesso e o risco.

### Segurança e actualização

- **HTTP não cifra o tráfego.** Credenciais, cookies de sessão e dados das tarefas
  podem ser interceptados ou alterados. Esta opção destina-se exclusivamente a
  instalações internas isoladas e aprovadas, nunca a redes públicas ou não confiáveis.
- Para HTTP directo, deixe `TRUSTED_PROXY`, `SSL_CERT` e `SSL_KEY` por definir.
  Remova `ALLOW_HTTP=true` e reinicie quando TLS estiver disponível.
- Não existem migrações de dados nem alterações de comportamento para instalações
  que não activem esta opção. HSTS anteriormente guardado pelo browser pode continuar
  a exigir HTTPS até expirar ou ser limpo.

### Verificação

- 209 testes aprovados, incluindo regressões de transporte por omissão, login HTTP,
  cookies e protecção CSRF; lint sem erros.
- Cobertura de linhas de 85,81%, acima dos limiares do projecto; auditoria de
  dependências de produção sem vulnerabilidades.
- Configuração Compose validada com valores de exemplo, sem usar segredos de produção.
- Integração Docker e verificações Linux/Node 20 e 22 sujeitas ao CI remoto antes da
  publicação; o Docker Desktop local não esteve disponível para executar a integração.

## 0.5.0

The first published release of this fork. Nothing had been tagged on the remote before this
version, so the local `v0.4.3` tag, which was never published, is superseded rather than
released.

### Highlights

- **Per-task failure alerting.** A task can set how many consecutive failures are tolerated before
  alerting, and how long to wait before repeating. A successful run clears the alert, so a new
  failure alerts immediately instead of waiting out a cooldown that belonged to an incident already
  over. Suppressed notifications are audited with a reason.
- **Per-task execution panel.** Last run, duration, exit code, last successful run, next scheduled
  run, consecutive failures, last alert sent, and recent executions with their trigger, without
  opening one log per task.
- **Passwords stored as scrypt digests.** `npx crontab-ui-hash` generates one. A digest from
  another tool is rejected at startup, and sign-in does the same work for an unknown user as for a
  wrong password, so response time does not disclose which accounts exist.
- **Revocable sessions.** Signing out withdraws the session record, so a copy of the cookie taken
  beforehand stops working immediately. Sign-in and sign-out are audited.
- **Mail profiles validated at startup**, with an administrator action to send a real test message
  to the recipients a profile already defines. Transport failures are reported as a category
  instead of the raw SMTP error, which can quote the username.
- **Oversized output no longer loses the alert.** A file above `MAIL_MAX_ATTACHMENT_BYTES` is
  attached truncated with an explicit notice rather than failing delivery.
- **A single owner for mail delivery failures.** The mailer records its own outcome; the parent
  records only a failure to start it.

### Breaking changes

These affect operators and any programmatic consumer.

- **`MAIL_PROFILES_JSON` must be valid when the service starts.** An invalid profile, or a digest
  that is well formed only by accident, stops the service from starting and names the profile.
  Previously a bad profile was only detected when a task selected it, or never.
- **`crontab.get_crontab` is error first.** It calls back with `(error, job)`. It also no longer
  reports a failed read as a task that does not exist; a read failure is now distinguishable from a
  missing task, and callers that relied on the old single argument must be updated.
- **Import and restore preserve local execution history.** Both replace the task set inside a
  transaction on every platform. Previously, on systems other than Windows, the database file was
  replaced, which also discarded the execution history and the alert state of the replaced tasks.
  Run history for tasks that remain is now kept; alert cooldowns and run records for tasks that
  no longer exist are dropped.
- **Numeric settings are range checked.** Execution, log, and retention limits fall back to their
  default when a value is unusable. A security limit such as `LOGIN_RATE_LIMIT_MAX` stops the
  service instead, because silently replacing it with a weaker value is the wrong direction to
  fail. Ranges are defined in `config/limits.js`.
- **`setupAuth` requires a session store** and refuses to start without one, because a session
  whose record is missing could never be revoked.

### Fixes worth calling out

- Every per-task log and execution route returned HTTP 500 whenever authentication was enabled.
  The body parser leaves `req.body` undefined for a request with no body, and the access middleware
  read the task id from it. This affected `/logger`, `/stdout` and `/executions` in any real
  deployment.
- `EXECUTION_HISTORY_PER_JOB` set to a value that is not a number deleted the entire execution
  history on the first run.
- A successful run did not clear the alert cooldown under a failure-only policy, so a finished
  incident could silence the next real alert for the full cooldown.

### Verification

- 206 tests, lint clean, production dependency audit with no vulnerabilities.
- Coverage 85.77% against thresholds of 70% lines, statements, and functions, and 65% branches.
- Continuous integration green on Node 20 and 22, including the Docker scheduler integration that
  publishes a task through the application, confirms the scheduler reload, and asserts the
  scheduled task runs as an unprivileged user.
- Restore rehearsed in an isolated instance: explicit backup, observable change, restore, task
  returned to the backed up command, publication review required, and execution history preserved.
