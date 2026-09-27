# Crontab UI

[English](README.md) | [Português (Portugal)](README.pt-PT.md)

Gestão web de tarefas cron com controlo de acesso, cópias de segurança, auditoria e limites de execução.

> A execução de uma tarefa é equivalente a executar o respetivo comando com os privilégios do processo do serviço. Instale a aplicação apenas em ambientes onde os administradores autorizados possam criar e publicar esses comandos.

## Origem canónica e versões

A origem canónica deste fork é [Kowts/crontab-ui](https://github.com/Kowts/crontab-ui). O remoto não tem, neste momento, tags publicadas: não substitua `<release-tag>` por uma versão assumida apenas a partir de `package.json`. Para produção, aprove um commit depois da validação, crie uma tag anotada e publique a release; o ramo `main` destina-se a desenvolvimento e validação contínua.

Não use `npm install -g crontab-ui` como instrução de instalação deste fork: esse nome pode resolver para outro pacote e não garante a presença dos controlos documentados aqui.

## Requisitos e limites da plataforma

- Node.js 20 ou superior;
- Linux/Unix com o binário `crontab` disponível para importar ou publicar no crontab do sistema;
- permissões de escrita apenas no diretório de dados e no mecanismo de agendamento gerido pelo serviço;
- para produção, TLS nativo ou reverse proxy HTTPS de confiança.

A interface e os testes podem correr em Windows, mas as operações **Get from crontab** e **Publish to crontab** dependem de `crontab` e não são suportadas nativamente nesse sistema operativo.

## Instalação a partir do repositório

Para desenvolvimento ou para preparar uma release candidata:

```bash
git clone https://github.com/Kowts/crontab-ui.git
cd crontab-ui
git checkout <commit-aprovado-ou-tag-publicada>
npm ci
npm run lint
npm test
```

Antes de iniciar, configure as variáveis no gestor de segredos/ambiente do processo. O projeto **não** carrega `.env` automaticamente. Defina sempre um `CRON_DB_PATH` persistente e com acesso exclusivo do utilizador do serviço.

```bash
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=8000
export CRON_DB_PATH=/var/lib/crontab-ui
export BASIC_AUTH_USERS_JSON='{"admin":"substitua-por-um-segredo"}'
export AUTHZ_ROLE_MAP_JSON='{"admin":"admin"}'
export CSRF_SECRET='substitua-por-um-segredo-aleatorio-longo'
export TRUSTED_PROXY='127.0.0.1'
npm start
```

O exemplo pressupõe que um proxy HTTPS local termina TLS e é a única origem que acede ao serviço. Consulte [a configuração Nginx](README/nginx.md) para o cabeçalho `X-Forwarded-Proto` e o valor de `TRUSTED_PROXY`.

## Deployment com Docker Compose

O `docker-compose.yml` não publica a porta da aplicação e passa `NODE_ENV=production`, `HOST=0.0.0.0`, `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON`, `CSRF_SECRET` e `TRUSTED_PROXY` para o contentor. A imagem é etiquetada localmente como `kowts/crontab-ui`. Declara a rede partilhada `crontab-ui-internal`, cujo nome pode ser alterado com `CRONTAB_UI_NETWORK`; o Compose do proxy deve referenciá-la como rede externa. O repositório não inclui um serviço Nginx, pelo que o proxy continua a ser gerido separadamente. Copie os valores abaixo para um ficheiro secreto, por exemplo `.env.production`, que **não** deve ser versionado:

```dotenv
# Escolha apenas este mecanismo para vários utilizadores.
BASIC_AUTH_USERS_JSON={"admin":"substitua-por-um-segredo","operator":"substitua-por-outro-segredo"}
AUTHZ_ROLE_MAP_JSON={"admin":"admin","operator":"operator"}
CSRF_SECRET=substitua-por-um-segredo-aleatorio-longo
CRONTAB_UI_NETWORK=crontab-ui-internal
# Exemplo ilustrativo: confirme a rede efetiva antes de usar este valor.
# Deve identificar a origem direta do proxy que encaminha para o contentor.
TRUSTED_PROXY=172.20.0.0/16
```

Valide os valores sem os expor no terminal e inicie:

```bash
docker compose --env-file .env.production up -d --build
docker compose ps
```

Para desenvolvimento local, a sobreposição publica a porta apenas em loopback. Este modo não substitui um teste de integração com o proxy de produção:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Não monte o diretório de crontab do anfitrião no contentor. Use exclusivamente o volume gerido `crontab-data`; montar o crontab do anfitrião concede à aplicação controlo sobre o agendamento do anfitrião e elimina o isolamento do contentor.

## Autenticação e autorização

Quando `HOST` não é loopback, a autenticação é obrigatória. Estão disponíveis duas alternativas:

- `BASIC_AUTH_USER` e `BASIC_AUTH_PWD`, para um único utilizador;
- `BASIC_AUTH_USERS_JSON`, para um mapa de vários utilizadores.

Se ambas estiverem definidas, `BASIC_AUTH_USERS_JSON` prevalece e o par individual é ignorado. Em instalações com autenticação, todos os utilizadores têm de constar em `AUTHZ_ROLE_MAP_JSON`.

| Papel | Capacidades |
| --- | --- |
| `viewer` | Consulta tarefas próprias, pré-visualização, exportação e registos. |
| `executor` | Capacidades de consulta e execução de tarefas próprias. |
| `operator` | Capacidades de consulta e criação, alteração, pausa, ativação, remoção e execução de tarefas próprias. |
| `admin` | Acesso global, ambiente, importação/exportação, cópias de segurança, restauro e importação do crontab do sistema. |

Cada tarefa criada recebe `owner` e `createdBy`. As tarefas antigas e as tarefas importadas do sistema não têm proprietário e ficam reservadas a administradores até serem recriadas ou atribuídas por um procedimento administrativo. A interface mostra proprietário, capacidades efetivas e se uma tarefa está apenas local ou publicada; o servidor continua a impor as permissões em todos os endpoints.

## Configuração de referência

`.env.example` é um modelo de nomes e formatos, não um ficheiro carregado pela aplicação. Mantenha segredos no cofre de segredos ou no ambiente do deployment.

| Variável | Finalidade e valor predefinido |
| --- | --- |
| `NODE_ENV` | Use `production` no deployment; ativa cookies seguros e exige TLS/proxy de confiança. |
| `HOST`, `PORT`, `BASE_URL` | Escuta HTTP e prefixo público. Predefinições: `127.0.0.1`, `8000`, sem prefixo. |
| `CRON_DB_PATH` | Diretório persistente para base, backups, ambiente e auditoria. Predefinição: `./crontabs`. |
| `CRON_PATH` | Diretório de staging do crontab. Deve ser acessível apenas ao processo da aplicação e ao mecanismo de agendamento isolado. |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PWD` | Autenticação de utilizador único; alternativa ao mapa JSON. |
| `BASIC_AUTH_USERS_JSON` | Mapa JSON de utilizadores e palavras-passe; tem precedência sobre o par individual. |
| `AUTHZ_ROLE_MAP_JSON` | Mapa JSON de utilizador para `viewer`, `executor`, `operator` ou `admin`. |
| `CSRF_SECRET` | Segredo persistente obrigatório em produção. |
| `SSL_CERT`, `SSL_KEY` | TLS nativo; devem ser definidos em conjunto. |
| `TRUSTED_PROXY` | Endereço, CIDR ou alias Express do proxy HTTPS de confiança. |
| `CRONTAB_UI_NETWORK` | Nome da rede Docker partilhada com o proxy. Predefinição Compose: `crontab-ui-internal`. |
| `MAIL_PROFILES_JSON` | Perfis SMTP/SMTPS exclusivos do servidor. As tarefas guardam apenas `profileId`. |
| `MAIL_MAX_ATTACHMENT_BYTES` | Limite por anexo de output de correio. Predefinição: `524288`. |
| `COMMAND_TIMEOUT_MS`, `COMMAND_MAX_BUFFER`, `COMMAND_KILL_GRACE_MS` | Limites de execução de tarefas e publicação. Predefinições: `300000`, `1048576`, `5000`. |
| `LOG_MAX_BYTES`, `LOG_ROTATION_COUNT`, `LOG_RETENTION_DAYS` | Tamanho, rotação e retenção de logs. Predefinições: `10485760`, `5`, `30`. |
| `BACKUP_RETENTION_COUNT`, `BACKUP_RETENTION_DAYS` | Número e idade máximos de backups. Predefinições: `30`, `90`. |
| `SYSTEM_CRONTAB_IMPORT_TIMEOUT_MS`, `SYSTEM_CRONTAB_IMPORT_MAX_BUFFER` | Limites da leitura `crontab -l`. Predefinições: `30000`, `262144`. |
| `ENABLE_AUTOSAVE` | Ativa publicação automática após alterações; só use quando o risco operacional tiver sido aceite. |

`CRON_IN_DOCKER` é uma variável interna da imagem Docker, não uma configuração de deployment público. `ALLOW_INSECURE_NO_AUTH` não é suportada em produção.

## Segurança do correio, ambiente e comandos

Os perfis de correio são definidos em `MAIL_PROFILES_JSON` e aceitam apenas `transporter` SMTP/SMTPS, `from` e um a vinte destinatários `to`. As credenciais não entram na base de dados, nas tarefas nem no browser. Falhas de transporte são auditadas; monitorize o diário de operações.

As variáveis de ambiente introduzidas na interface aceitam apenas linhas `NOME=valor`, com nomes que respeitem `^[A-Z_][A-Z0-9_]*$`. Sintaxe de shell (`export`, `$()`, backticks, pipes, redirecionamentos e `;`) é rejeitada. Isto não transforma comandos de tarefas em seguros: esses comandos continuam a ser uma capacidade privilegiada e devem ser revistos antes de serem criados.

Cada execução manual ou agendada tem timeout, limite conjunto de output e encerramento SIGTERM/SIGKILL. A importação e publicação do crontab usam execução sem shell; a importação é limitada, deduplicada, protegida por bloqueio e só responde depois de terminar. Em Linux, o executor termina o grupo de processos; em Windows a terminação completa da árvore depende do sistema operativo.

## Backups, recuperação e auditoria

Antes de importar uma base ou restaurar um backup, a aplicação cria uma cópia de segurança e valida o candidato antes de substituir a base ativa. Os backups reconhecidos seguem a retenção por quantidade e idade; falhas de retenção são auditadas.

Procedimento de recuperação:

1. Suspenda o acesso público no proxy, preservando o volume `crontab-data` e `crontabs/logs/operations.jsonl`.
2. Identifique o `operationId` mostrado na interface ou no cabeçalho `X-Request-ID` e preserve o contexto da falha.
3. Numa instância isolada, valide a cópia exportada ou o backup candidato.
4. Use apenas a área administrativa **Backups** para restaurar um backup reconhecido.
5. Confirme as tarefas, ambiente e pré-visualização antes de publicar novamente no crontab.

Não execute o serviço como `root` para contornar permissões e não use `--reset` como recuperação de rotina: ambos podem invalidar a separação de privilégios ou apagar a configuração ativa. Corrija permissões do volume e restaure um backup validado.

O diário `operations.jsonl` contém eventos estruturados com actor, papel, resultado, duração e IDs de correlação. Comandos são registados por hash SHA-256. Exporte o diário para retenção central com acesso restrito e teste restauros regularmente numa instância não produtiva.

Hooks arbitrários não são suportados. Para pós-processamento, use uma tarefa explícita, revista e auditável.

## Checklist de lançamento

1. Fixe uma release/tag de `Kowts/crontab-ui` e execute `npm ci`.
2. Configure autenticação, RBAC, `CSRF_SECRET`, `CRON_DB_PATH` persistente e TLS nativo ou `TRUSTED_PROXY`.
3. Execute `npm run lint`, `npm test`, `npm run test:coverage` e `npm audit --omit=dev --audit-level=high`.
4. Execute um restauro de teste numa instância isolada e confirme a retenção de backups e logs.
5. Faça build e execução reais da imagem Docker na plataforma alvo, verificando a compatibilidade de `crond`, capacidades e volume persistente.

## Recursos

- [Configuração de Nginx e TLS](README/nginx.md)
- [Diagnóstico e recuperação](README/issues.md)
- [Licença MIT](LICENSE.md)
