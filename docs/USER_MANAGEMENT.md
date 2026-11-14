# User & Access Management

## Âmbito

A gestão de contas no painel só está activa com `AUTH_PROVIDER=sqlite`. O provider `env` continua a ser a predefinição compatível com as instalações existentes. Os perfis são fixos: `viewer`, `executor`, `operator` e `admin`.

As contas usam a tabela SQLite `users`; a coluna `password_hash` aceita exclusivamente hashes scrypt. Listagens, respostas HTTP e auditoria nunca incluem hashes ou passwords. A password introduzida no reset é enviada apenas ao endpoint de reset, hashed no servidor e descartada depois.

## Migração do provider env

1. Manter `AUTH_PROVIDER=env` e as credenciais/configuração `BASIC_AUTH_USERS_JSON` ou `BASIC_AUTH_USER`/`BASIC_AUTH_PWD`, com `AUTHZ_ROLE_MAP_JSON`.
2. Criar cópia de segurança adicional e verificar o backup existente da SQLite.
3. Executar o comando no mesmo ambiente e com o mesmo `CRON_DB_PATH` do serviço:

```bash
node --env-file=.env.production bin/crontab-ui-users.js migrate
```

4. O CLI valida utilizadores e perfis, cria outro backup verificado e importa as contas numa transacção. Passwords em claro são convertidas para scrypt; hashes scrypt válidos são preservados. A migração é idempotente para contas cuja password/role correspondam. Conflitos bloqueiam a operação sem importação parcial.
5. Confirmar a mensagem de backup, o número de contas e pelo menos um administrador activo.
6. Alterar a configuração para `AUTH_PROVIDER=sqlite` e reiniciar o serviço. A aplicação recusa arrancar se não existir um administrador activo.
7. Só depois de validar login, perfis, reset e sessões, retirar as credenciais de utilizador do ambiente. Mantê-las protegidas durante o período de rollback aprovado.

`AUTH_PROVIDER=env` não sincroniza alterações feitas à tabela SQLite. Não alternar providers para replicar contas.

## Administração no painel

Com provider SQLite e uma conta admin, abrir **Users & Permissions**.

- Criar contas com username normalizado, password de pelo menos 12 caracteres e um dos quatro perfis fixos.
- Pesquisar e filtrar por username, perfil e estado.
- A pesquisa e os filtros de perfil/estado têm rótulos visíveis e adaptam-se a ecrãs estreitos.
- As permissões aparecem como uma contagem; **Ver detalhes** expande a lista e as restrições de ownership, estado e execução de operadores.
- Estados activos/inactivos usam indicadores com texto. **Editar** permanece visível; reset e activação/desactivação ficam no menu de acções da conta.
- Editar perfil e activar/desactivar. Cada alteração exige a revisão actual da conta.
- Repor password através de **Reset password**; todas as sessões da conta são revogadas.
- Alteração de perfil ou estado também revoga todas as sessões existentes.
- A desactivação é a operação normal. Não existe eliminação física, preservando a identidade associada a histórico e auditoria.
- A última conta admin activa não pode ser desactivada nem despromovida.

### Perfis efectivos

| Perfil | Permissões efectivas |
| --- | --- |
| `viewer` | Consulta apenas tarefas próprias e registos permitidos. |
| `executor` | Consulta e executa tarefas próprias; não as edita. |
| `operator` | Opera apenas tarefas próprias quando `ALLOW_OPERATOR_TASK_EXECUTION=true`; caso contrário, é de consulta. |
| `admin` | Acesso global, gestão de utilizadores, ambientes, backups, importação e recuperação. |

As verificações do servidor continuam a impor propriedade das tarefas; a UI não é a fronteira de autorização.

### Verificações de regressão

Os testes de gestão de utilizadores verificam:

- Recusa de acesso à página e APIs com uma sessão revogada após desactivação, mesmo depois de reactivar a conta.
- Revogação da sessão de um admin despromovido e recusa das APIs administrativas após novo login como viewer.
- Duas ligações SQLite em processos concorrentes a desactivar/despromover os últimos admins: apenas uma alteração é aceite e permanece um admin activo.
- Restauro de backup sem tabela `users` preserva passwords, perfis e sessões locais; backups novos substituem contas e revogam sessões.
- Eventos administrativos incluem actor, conta alvo e timestamp, sem passwords ou hashes.

Estas verificações não substituem o ensaio operacional de `native-local` ou do agente Ubuntu.

## API administrativa

Todos os endpoints exigem role `admin`, sessão autenticada e CSRF nas operações mutáveis:

- `GET /api/users?q=&role=&active=&limit=&offset=` lista sem campos de password.
- `GET /api/users/:id` consulta uma conta.
- `POST /api/users` cria username, password e role.
- `PATCH /api/users/:id` actualiza role/estado com revisão optimista.
- `POST /api/users/:id/activate` e `/deactivate` alteram o estado com revisão.
- `POST /api/users/:id/reset-password` substitui a password e revoga sessões.

Criação, alterações de perfil/estado, reset e recuperação CLI ficam no diário `operations.jsonl`. O conteúdo de password e hash é excluído dos metadados de auditoria.

## Recuperação administrativa

O comando seguinte cria ou recupera um admin, define uma password aleatória forte, revoga sessões anteriores e cria um backup antes de alterar a conta:

```bash
AUTH_PROVIDER=sqlite node --env-file=.env.production bin/crontab-ui-users.js recover-admin administrator
```

A password temporária é mostrada uma vez no terminal e não é escrita no log. Registá-la num gestor de segredos e substituí-la pela UI após iniciar sessão. Executar o comando localmente como a conta de serviço ou outro operador autorizado a escrever na base; nunca executar como root só para contornar permissões.

## Rollback

O schema SQLite é aditivo; as contas e hashes permanecem na base. Para rollback da aplicação, usar uma versão compatível com `users` ou restaurar o backup criado antes da migração. Se regressar a `AUTH_PROVIDER=env`, restaurar as credenciais/perfis guardados no gestor de segredos. Não há exportação automática de passwords SQLite para o `.env`, porque os hashes não podem ser convertidos de volta.

Backups criados após a migração incluem contas e hashes scrypt. Restaurar um destes backups substitui o conjunto SQLite de contas e revoga todas as sessões da base activa; em `AUTH_PROVIDER=sqlite`, o restore é recusado se não contiver pelo menos um admin activo. Backups anteriores à migração, sem tabela `users`, restauram tarefas/ambientes mas preservam o conjunto actual de contas e sessões, permitindo rollback sem perder a administração SQLite.

Validar esta transição numa instância independente antes de produção. Não executar migração, reset ou restore em produção sem backup verificado e procedimento de mudança aprovado.
