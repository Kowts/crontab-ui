Crontab UI
==========

[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=U8328Q7VFZMTS)
[![npm](https://img.shields.io/npm/v/crontab-ui.svg?style=flat-square)](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)
[![npm](https://img.shields.io/npm/dt/crontab-ui.svg?style=flat-square)](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)
[![npm](https://img.shields.io/npm/dm/crontab-ui.svg?style=flat-square)](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)
[![npm](https://img.shields.io/docker/pulls/alseambusher/crontab-ui.svg?style=flat-square)](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)
[![npm](https://img.shields.io/npm/l/crontab-ui.svg?style=flat-square)](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)

Editing the plain text crontab is error prone for managing jobs, e.g., adding jobs, deleting jobs, or pausing jobs. A small mistake can easily bring down all the jobs and might cost you a lot of time. With Crontab UI, it is very easy to manage crontab. Here are the key features of Crontab UI.

![flow](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/flow.gif)

1. Easy setup. You can even import from existing crontab.
2. Safe adding, deleting or pausing jobs. Easy to maintain hundreds of jobs.
3. Backup your crontabs.
4. Export crontab and deploy on other machines without much hassle.
5. Error log support.
6. Optional server-managed email notifications.

Read [this](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html) to see more details.

## Setup

Get latest `node` from [here](https://nodejs.org/en/download/current/). Then,

    npm install -g crontab-ui
    crontab-ui

If you need to set/use an alternative host, port OR base url, you may do so by setting an environment variable before starting the process:

    HOST=0.0.0.0 PORT=9000 BASE_URL=/alse crontab-ui

By default, db, backups and logs are stored in the installation directory. It is **recommended** that it be overriden using env variable `CRON_DB_PATH`. This is particularly helpful in case you **update** crontab-ui.

    CRON_DB_PATH=/path/to/folder crontab-ui
    
If you need to apply basic HTTP authentication, you can set user name and password through environment variables:

    BASIC_AUTH_USER=user BASIC_AUTH_PWD=SecretPassword
    
Also, you may have to **set permissions** for your `node_modules` folder. Refer [this](https://docs.npmjs.com/getting-started/fixing-npm-permissions).

If you need to use SSL, you can pass the private key and certificate through environment variables:

    SSL_CERT=/path/to/ssl_certificate SSL_KEY=/path/to/ssl_private_key

Make sure node has the correct **permissions** to read the certificate and the key.

If you need to autosave your changes to crontab directly:

    crontab-ui --autosave

### List of environment variables supported
- HOST
- PORT
- BASE_URL
- CRON_DB_PATH
- CRON_PATH
- BASIC_AUTH_USER, BASIC_AUTH_PWD
- BASIC_AUTH_USERS_JSON
- AUTHZ_ROLE_MAP_JSON
- SSL_CERT, SSL_KEY 
- ENABLE_AUTOSAVE
- CSRF_SECRET
- MAIL_PROFILES_JSON
- MAIL_MAX_ATTACHMENT_BYTES
- TRUSTED_PROXY
- COMMAND_TIMEOUT_MS
- COMMAND_MAX_BUFFER
- COMMAND_KILL_GRACE_MS
- LOG_MAX_BYTES
- LOG_ROTATION_COUNT
- LOG_RETENTION_DAYS
- BACKUP_RETENTION_COUNT
- BACKUP_RETENTION_DAYS
- SYSTEM_CRONTAB_IMPORT_TIMEOUT_MS
- SYSTEM_CRONTAB_IMPORT_MAX_BUFFER

## Segurança e operação

`.env.example` é apenas um modelo: a aplicação não carrega ficheiros `.env` automaticamente. Configure as variáveis no gestor de segredos e ambiente do processo/deployment. Nunca coloque credenciais SMTP, chaves TLS ou palavras-passe no repositório, na base de tarefas ou no browser.

Quando `HOST` não é loopback, `BASIC_AUTH_USER` e `BASIC_AUTH_PWD` são obrigatórios. Para produção, coloque a aplicação atrás de um reverse proxy com TLS e exponha apenas HTTPS. Defina um `CSRF_SECRET` longo e aleatório para manter os tokens válidos após reinícios controlados.

Em produção, a aplicação exige `SSL_CERT`/`SSL_KEY` ou `TRUSTED_PROXY` com endereços/CIDRs de proxy conhecidos; ligações não seguras recebem `426`. `ALLOW_INSECURE_NO_AUTH` é recusado. O `docker-compose.yml` usa apenas rede interna; para desenvolvimento local use `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.

### Autorização por função (RBAC)

Para instalações com mais de um operador, configure `BASIC_AUTH_USERS_JSON` com o mapa de utilizadores e palavras-passe, e `AUTHZ_ROLE_MAP_JSON` com um papel explícito para cada utilizador. Ambos são segredos/configuração exclusiva do servidor. Quando a autenticação está activa, um utilizador sem papel é recusado por defeito.

- `viewer`: consulta tarefas, pré-visualização, exportação e registos;
- `executor`: inclui consulta e pode executar tarefas próprias, sem as alterar;
- `operator`: inclui o papel de consulta e pode criar, alterar, iniciar, parar, apagar e executar tarefas;
- `admin`: inclui os papéis anteriores e pode alterar ambiente, importar/restaurar/apagar cópias de segurança e importar o crontab do sistema.

Cada nova tarefa recebe `owner` e `createdBy` no servidor. Um `operator` só pode gerir tarefas próprias; um `viewer` só pode consultar tarefas próprias; `admin` tem acesso global. Tarefas antigas ou importadas sem owner são consideradas legadas e ficam reservadas a administração até serem recriadas ou atribuídas por procedimento administrativo.

A lista de tarefas mostra o proprietário, as capacidades efectivas do utilizador e se a alteração existe apenas localmente ou já foi publicada no crontab do serviço. Estes elementos são informativos: a autorização continua a ser imposta pelo servidor em todos os endpoints. Quando uma operação falha, a interface apresenta o ID de auditoria devolvido pelo servidor (`X-Request-ID` ou o ID da execução), que deve acompanhar qualquer pedido de suporte.

Exemplo: `BASIC_AUTH_USERS_JSON={"ana":"segredo-ana","bruno":"segredo-bruno"}` e `AUTHZ_ROLE_MAP_JSON={"ana":"admin","bruno":"operator"}`. Armazene estes valores no cofre de segredos; nunca no repositório. O acesso sem autenticação permanece possível apenas em loopback para desenvolvimento.

Os perfis SMTP são definidos exclusivamente em `MAIL_PROFILES_JSON`. Cada perfil tem exclusivamente `transporter` (`smtp://` ou `smtps://`), `from` e `to` (um ou até 20 endereços); as tarefas guardam apenas uma referência de perfil, nunca a credencial. A configuração de correio é responsabilidade do administrador do serviço. As notificações só anexam `stdout` e `stderr` da tarefa, lidos do directório de execução, e cada anexo é limitado por `MAIL_MAX_ATTACHMENT_BYTES` (predefinição: 512 KiB). O transporte bloqueia acessos a ficheiros e URLs do Nodemailer e usa limites de ligação, saudação e socket.

As variáveis configuradas na interface aceitam apenas linhas `NOME=valor`, com nomes maiúsculos que respeitem `^[A-Z_][A-Z0-9_]*$`. São passadas ao processo como ambiente Node, nunca concatenadas a uma shell. Sintaxe shell como `export`, `$()`, backticks, pipes, redireccionamentos e `;` é recusada.

O processo deve executar com o menor privilégio possível. Não monte o crontab do anfitrião num contentor e não conceda acesso ao serviço a utilizadores que não possam criar comandos agendados. A execução de uma tarefa é equivalente à execução de um comando pelo utilizador do serviço.

### Retenção e auditoria

Cada execução, manual ou agendada, usa o mesmo executor, com `COMMAND_TIMEOUT_MS`, limite conjunto de output `COMMAND_MAX_BUFFER` e encerramento SIGTERM/SIGKILL configurável por `COMMAND_KILL_GRACE_MS`. Os comandos internos de publicação e importação do crontab também são executados sem shell e com timeout/limite de output. Em Linux o executor cria um grupo de processos e termina esse grupo; em Windows a terminação da árvore depende do sistema operativo. Para isolamento forte de CPU, memória e PIDs, execute a aplicação num contentor com limites ou através de cgroups/systemd no anfitrião.

Os logs de tarefas são limitados por `LOG_MAX_BYTES`, rodam até `LOG_ROTATION_COUNT` ficheiros e continuam sujeitos a `LOG_RETENTION_DAYS`. O mesmo limite, rotação e retenção aplicam-se ao diário de auditoria `crontabs/logs/operations.jsonl`. Cada operação administrativa, recusa de autenticação/autorização e execução é registada em JSON Lines com ID de correlação, actor/papel quando aplicável, IP de origem, resultado e duração; comandos são representados apenas pelo seu hash SHA-256. Configure também `BACKUP_RETENTION_COUNT` e `BACKUP_RETENTION_DAYS`. Falhas de limpeza são registadas na auditoria; monitorize e exporte esse ficheiro para armazenamento centralizado com acesso restrito.

A importação do crontab do sistema executa `crontab -l` sem shell, tem os limites `SYSTEM_CRONTAB_IMPORT_TIMEOUT_MS` e `SYSTEM_CRONTAB_IMPORT_MAX_BUFFER`, e mantém a leitura, cópia de segurança e substituição da base de dados sob o mesmo bloqueio. A resposta só é enviada após a importação terminar; linhas não agendadas (comentários e variáveis de ambiente) são ignoradas, e tarefas já existentes com o mesmo horário e comando não são duplicadas.

### Recuperação

Antes de uma importação ou restauro é criada uma cópia de segurança. Para recuperar, abra um backup na interface e use **Restore**. A aplicação valida o ficheiro candidato antes de substituir a base activa e impede operações concorrentes. Teste regularmente a recuperação numa cópia não produtiva.

Hooks arbitrários não são suportados: foram removidos da interface para evitar execução adicional não auditada. Use uma tarefa explícita e revista para qualquer pós-processamento.

### Procedimento de lançamento e incidente

1. Defina `NODE_ENV=production`, autenticação, RBAC, `CSRF_SECRET` e TLS nativo ou `TRUSTED_PROXY` antes de iniciar; o arranque falha se a configuração de transporte ou papéis estiver incompleta.
2. Execute `npm ci`, `npm run lint`, `npm test`, `npm run test:coverage` e `npm audit --omit=dev --audit-level=high` na versão candidata.
3. Conserve o volume `crontab-data`, exporte `operations.jsonl` para retenção central e valide periodicamente um restauro numa instância isolada.
4. Em incidente, suspenda a exposição no proxy, preserve a auditoria e os backups, identifique o `operationId`, e restaure apenas um backup reconhecido através da interface administrativa. Não substitua manualmente `crontab.db` em produção.


## Docker
For production, do not publish this service directly to the Internet. Terminate TLS in a reverse proxy, expose only HTTPS, and set `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON` and `CSRF_SECRET` through the deployment secret store. The Compose file refuses to start without them.

Never mount the host's crontab directory into this container: doing so gives the web application control over host scheduling. Use the managed `crontab-data` volume instead.

You can use crontab-ui with docker. You can use the prebuilt images in the [dockerhub](https://hub.docker.com/r/alseambusher/crontab-ui/tags)
Use the Compose deployment behind a TLS reverse proxy. For local development only, publish loopback with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.

You can also build it yourself if you want to customize, like this:
```bash
git clone https://github.com/alseambusher/crontab-ui.git
cd crontab-ui
docker build -t alseambusher/crontab-ui .
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Host crontab mounts are intentionally unsupported because they defeat container isolation.

    
## Resources

* [Full usage details](https://lifepluslinux.blogspot.com/2015/06/crontab-ui-easy-and-safe-way-to-manage.html)
* [Issues](https://github.com/alseambusher/crontab-ui/blob/master/README/issues.md)
* [Setup Mailing after execution](https://lifepluslinux.blogspot.com/2017/03/introducing-mailing-in-crontab-ui.html)
* [Integration with nginx and authentication](https://github.com/alseambusher/crontab-ui/blob/master/README/nginx.md)
* [Setup on Raspberry pi](https://lifepluslinux.blogspot.com/2017/03/setting-up-crontab-ui-on-raspberry-pi.html)

### Adding, deleting, pausing and resuming jobs.

Once setup Crontab UI provides you with a web interface using which you can manage all the jobs without much hassle.

![basic](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/main.png)

### Import from existing crontab

Import from existing crontab file automatically.
![import](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/import.gif)

### Backup and restore crontab

Keep backups of your crontab in case you mess up.
![backup](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/backup.png)

### Export and import crontab on multiple instances of Crontab UI.

If you want to run the same jobs on multiple machines simply export from one instance and import the same on the other. No SSH, No copy paste!

![export](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/import_db.png)

A backup is created automatically before importing.

### Separate error log support for every job
![logs](https://github.com/alseambusher/crontab-ui/raw/gh-pages/screenshots/log.gif)

### Donate
Like the project? [Buy me a coffee](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=U8328Q7VFZMTS)!

### Contribute
Fork Crontab UI and contribute to it. Pull requests are encouraged.

### License
[MIT](LICENSE.md)
