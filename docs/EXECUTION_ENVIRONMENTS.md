# Ambientes de execução

## Estado da implementação

O catálogo central, a API administrativa, a página de gestão, as tarefas estruturadas, a validação de payload e o despacho fail-closed estão implementados. O caminho `command` existente permanece separado e continua a usar o executor legado.

A execução structured no contentor requer roots e executáveis allowlisted. `native-local` executa directamente na instalação nativa Linux, sem shell, com wrapper e limites cgroup v2 próprios; em Docker fica indisponível e nunca executa no host. `ubuntu-local` continua a usar o agente host com política independente. Sem configuração válida, todos os destinos falham fechados; não há fallback silencioso.

O serviço e os wrappers C foram implementados e validados operacionalmente numa VM Ubuntu: compilação dos wrappers, permissões reais do socket, delegação cgroup v2, reinícios forçados, processos descendentes e cenário ETL de ensaio.

## Catálogo central

1. Iniciar a versão actual da aplicação e criar um backup verificado da SQLite.
2. Entrar como administrador e abrir **Ambientes de execução**.
3. Criar o runtime com path absoluto no namespace do destino; códigos são únicos e imutáveis.
4. Guardar e usar **Validar ambiente**. Um estado `valid` é informativo e não substitui a política do destino.
5. Criar uma tarefa em modo **Estruturado**, seleccionar o ambiente e preencher script, directório de trabalho, argumentos individuais e timeout.
6. Rever a lista de argumentos e o estado do destino; os argumentos nunca são interpretados por shell.

Variáveis de ambiente definidas na tarefa não são suportadas. Não guardar passwords, tokens ou segredos em argumentos, paths ou logs.

Na página de gestão, os filtros de destino, runtime e estado têm rótulos visíveis e partilham a mesma linha em desktop. Em ecrãs estreitos, adaptam-se à largura disponível e a tabela tem deslocação horizontal própria.

**Ver detalhes** expande os caminhos completos do executável e do directório de trabalho. Os estados de activação e validação têm indicadores com texto. **Editar** permanece visível; o menu de acções contém **Activar/Desactivar**, mantendo a confirmação e a revisão optimista existentes. A validação continua disponível no separador **Execução** do editor; estes indicadores não substituem a política do destino.

## Execução structured no contentor

O Compose mantém esta capacidade desactivada por omissão. Para a activar, definir `STRUCTURED_EXECUTION_ROOTS` como lista separada por vírgulas de directórios absolutos, root-owned e não graváveis por grupo/outros, e `STRUCTURED_EXECUTION_EXECUTABLES` como lista de paths canónicos exactos dos runtimes aprovados. O runtime e os scripts não podem pertencer ao utilizador `node`; os ficheiros e ancestrais são novamente verificados antes de cada execução.

Não montar pastas ETL do host para contornar incompatibilidades de ABI. Não colocar scripts ou executáveis autorizados em directórios graváveis pelo utilizador do serviço. As raízes são uma fronteira de política, não uma sandbox; scripts aprovados executam com os privilégios do processo executor.

## Execução structured nativa

`native-local` só está disponível numa instalação Linux fora de Docker (`CRON_IN_DOCKER` deve estar ausente). Configurar `STRUCTURED_EXECUTION_ROOTS`, `STRUCTURED_EXECUTION_EXECUTABLES`, `STRUCTURED_EXECUTION_CGROUP_WRAPPER` e os limites `STRUCTURED_EXECUTION_MEMORY_MAX_BYTES`, `STRUCTURED_EXECUTION_CPU_QUOTA_PERCENT` e `STRUCTURED_EXECUTION_PIDS_MAX`.

| Variável | Finalidade | Predefinição |
| --- | --- | --- |
| `STRUCTURED_EXECUTION_ROOTS` | Roots POSIX autorizadas para scripts e directórios. | vazio, desactivado |
| `STRUCTURED_EXECUTION_EXECUTABLES` | Paths canónicos exactos dos runtimes aprovados. | vazio, desactivado |
| `STRUCTURED_EXECUTION_TRUSTED_OWNER_UIDS` | UIDs confiáveis para ficheiros/root pertencentes ao utilizador da aplicação. Lista numérica separada por vírgulas. | vazio |
| `STRUCTURED_EXECUTION_TRUSTED_GROUP_GIDS` | Opt-in Native Linux: GIDs numéricos confiáveis para escrita de código/runtime nos caminhos aprovados. | vazio |
| `STRUCTURED_EXECUTION_GROUP_WRITABLE_ROOTS` | Raízes canónicas existentes onde se aceita escrita pelos grupos confiáveis. Configurar juntamente com GIDs; `/` é recusado. | vazio |
| `STRUCTURED_EXECUTION_CGROUP_WRAPPER` | Path do wrapper C root-owned que coloca o processo no cgroup antes do `execve`. | vazio |
| `STRUCTURED_EXECUTION_MEMORY_MAX_BYTES` | Memória máxima por execução. | `536870912` |
| `STRUCTURED_EXECUTION_CPU_QUOTA_PERCENT` | Quota CPU por execução; `100` equivale a um CPU. | `100` |
| `STRUCTURED_EXECUTION_PIDS_MAX` | Máximo de processos/threads por execução. | `64` |

Por defeito, executáveis, scripts, roots e directórios pertencentes à conta do serviço são recusados. Se os ETLs existentes forem mantidos por essa mesma conta, o administrador pode definir `STRUCTURED_EXECUTION_TRUSTED_OWNER_UIDS` para UIDs específicos. Esta opção é uma declaração explícita de confiança: os scripts correm com a identidade e acesso a ficheiros da aplicação, não são sandbox e podem alterar outros ficheiros dessa conta. Não adicionar UIDs sem revisão do risco.

Para instalações colaborativas, `STRUCTURED_EXECUTION_TRUSTED_GROUP_GIDS` e `STRUCTURED_EXECUTION_GROUP_WRITABLE_ROOTS` permitem uma excepção explícita e limitada à escrita pelo grupo. As listas são separadas por vírgulas e têm de ser configuradas em conjunto. Só se aceita a escrita se o GID do ficheiro/directório estiver autorizado e o caminho estiver numa das raízes canónicas aprovadas; os ficheiros alvo e ancestrais inspeccionados são verificados. A raiz de grupo não autoriza scripts ou executáveis por si só: continuam a aplicar-se `STRUCTURED_EXECUTION_ROOTS`, a allowlist de executáveis e a confiança de UID. Links de runtime mantêm a verificação do caminho canónico e dos ancestrais do link.

Escrita por outros é sempre recusada, mesmo num grupo confiável. `container-local` e o agente Ubuntu não usam esta excepção. Confiar no grupo significa aceitar todos os seus membros com escrita como autores de código executado com os acessos da conta do serviço; não concede isolamento contra alterações ao venv, dependências ou scripts. Preferir raízes específicas, rever membros e dependências, e revalidar após alterações. Não instalar dependências automaticamente na validação nem executar um ETL de produção como teste do venv.

O wrapper `agent/exec-wrapper.c` deve ser compilado e instalado root-owned, sem setuid/capacidades, no path configurado:

```bash
cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now \
  agent/exec-wrapper.c -o /usr/local/libexec/crontab-ui-agent-exec
```

A unidade systemd da aplicação tem de delegar `cpu`, `memory` e `pids`; [crontab-ui-native-cgroup.conf.example](../deploy/systemd/crontab-ui-native-cgroup.conf.example) mostra as directivas necessárias. Requer systemd 254 ou superior, com `DelegateSubgroup=crontab-ui-supervisor`: o serviço inicia nesse subgrupo, deixando o cgroup-pai da unidade sem processos. Na validação/execução nativa, a aplicação activa os controllers nesse pai delegado e cria os cgroups das tarefas como irmãos do supervisor. Não activa controllers fora dessa estrutura nem move processos existentes entre cgroups.

`Delegate=yes` isoladamente não é suficiente. Verificar `systemd --version` antes de instalar o drop-in; após `daemon-reload` e reinício numa janela de manutenção, `/proc/<MainPID>/cgroup` deve terminar em `/crontab-ui.service/crontab-ui-supervisor` (ou no nome real da unidade). Se o systemd ignorar a directiva ou os controllers/permissões não estiverem disponíveis, a validação é recusada com diagnóstico explícito. O ensaio Ubuntu continua obrigatório: confirmar validação, cgroup de cada execução, limites e cancelamento antes de produção.

Runners nativos iniciados por cron não herdam a pertença ao cgroup do Crontab UI. Para tarefas `native-local`, o runner envia apenas ID de operação, ID da tarefa e fingerprint da configuração ao dispatcher da aplicação; nunca executa o runtime directamente. As demais tarefas mantêm o caminho anterior. O cron continua a ser o agendador, sem segundo scheduler.

### Dispatcher nativo para cron

O dispatcher é opt-in: `ENABLE_NATIVE_DISPATCH=true` no ambiente da unidade delegada. Antes de activar, provisionar uma chave binária aleatória de 32 bytes em `CRON_DB_PATH/native-dispatch.key`, pertencente à conta do serviço e modo `0600`. O directório `CRON_DB_PATH` tem de ser propriedade dessa conta, sem acesso por grupo/outros. Usar o mesmo caminho absoluto da base no serviço e nos runners publicados; caminhos de socket acima de 100 bytes são recusados.

Com a identidade do serviço, numa instalação com base privada já existente, executar uma vez (o comando recusa sobrescrever uma chave):

```bash
node -e "require('./lib/native-dispatch').initializeKey('/absolute/private/database-directory')"
```

Não imprimir nem versionar a chave; nunca colocá-la na linha cron ou no ambiente dos scripts. A autenticação reutiliza HMAC com timestamp, nonce e rejeição de replay. A autorização volta a ler a tarefa no serviço: tem de estar publicada, activa, sem revisão pendente, com ambiente Native Linux validado e fingerprint coincidente. O pedido não aceita comandos, paths ou argumentos arbitrários. A chave permite despacho/cancelamento de tarefas aprovadas e consulta do estado; acesso à conta Unix e à chave é uma fronteira de confiança.

O serviço abre `native-dispatch.sock` com modo `0600` no directório privado. O cron tem de executar com essa mesma conta e conseguir ler a chave. Não conceder acesso ao grupo ETL ao directório da base. Em falta de chave, dispatcher ou autorização, a execução falha explicitamente, sem fallback. O dispatcher reutiliza `crontab.runjob` e o executor comum; histórico, output e notificações são produzidos no serviço, com trigger `scheduled` e ID de operação único. O timeout registado corresponde ao timeout structured efectivo.

`native-dispatch.db` guarda aceitação e resultados, reutilizando o datastore do agente. Repetir o mesmo ID não executa novamente; um ID usado com outro pedido é recusado. Operações sem desfecho no reinício ficam `unknown`, não são reexecutadas. O runner consulta o mesmo ID após perda de acknowledgement e nunca volta a submeter uma operação incerta. Uma nova ocorrência cron tem um novo ID: não é retry de uma ocorrência anterior. Conservar esta base durante recuperação para manter a evidência de idempotência; snapshots da base principal não contêm este diário separado.

No encerramento normal, o dispatcher cancela os controladores activos e aguarda os callbacks; o limite de 10 segundos do bootstrap mantém-se. SIGKILL depende de `KillMode=control-group` e deve ser ensaiado no Ubuntu. A validação manual não comprova o cron: testar uma tarefa não destrutiva publicada, confirmar o cgroup do serviço e uma única execução no histórico antes de aprovar produção. Sem wrapper seguro, controllers delegados ou permissões correctas, a validação e execução são recusadas.

`native-local` não é apresentado como isolamento de identidade: é execução directa sem shell e com limites cgroup por processo, sob a conta do Crontab UI. Para fronteira de identidade separada, usar `ubuntu-local` e o agente dedicado.

## Agente Ubuntu

### Pré-requisitos

- Ubuntu/Linux com cgroup v2 e systemd;
- Node.js compatível com o projecto e dependências instaladas num directório controlado;
- utilizador de serviço não privilegiado `svc-crontab-ui-agent`;
- grupo de clientes do socket, por exemplo `crontab-ui-clients`, contendo apenas a identidade de serviço do Crontab UI;
- wrappers compilados com GCC, sem setuid e sem capacidades Linux;
- tarefas/scripts e runtime legíveis/executáveis pela conta do agente, mas não graváveis por ela;
- directórios cgroup `cpu`, `memory` e `pids` delegados à unidade systemd.

O agente requer systemd 254 ou superior e `DelegateSubgroup=crontab-ui-supervisor`.
O processo supervisor ocupa esse subgrupo; o agente activa os controllers no
cgroup-pai vazio e cria os grupos de execução como irmãos do supervisor.

Não executar o agente como root, não conceder `sudo`, não expor TCP, Docker socket, SSH genérico ou PID namespace do host.

### Política independente

Copiar [policy.example.json](../deploy/systemd/policy.example.json) para `/etc/crontab-ui-agent/policy.json`, substituir `replace-with-job-id` pelo ID real da tarefa e reduzir a allowlist aos scripts necessários. A política deve ser propriedade de root, não gravável pelo agente nem pelo Crontab UI, e legível apenas por root e pelo grupo dedicado do agente. Cada alteração exige revisão, incremento de `revision` e revalidação no catálogo central.

O agente verifica o ID da tarefa, código/revisão do ambiente, runtime, paths exactos, UID proprietário, permissões, padrão e quantidade de cada argumento, timeout, concorrência, output, memória, CPU e PIDs. Para executáveis symlink, a política fixa o path do link e o `executable_realpath` esperado; ambos os ancestrais e proprietários são verificados. Scripts e directórios de trabalho não aceitam symlinks. A UI não consegue actualizar esta política.

### Segredo e socket

Gerar uma chave aleatória hexadecimal com pelo menos 32 bytes. Guardar a mesma chave em `/etc/crontab-ui-agent/agent.env` (root:root, modo `0600`) e no gestor de segredos utilizado pelo Compose. O systemd lê o `EnvironmentFile` antes de iniciar o serviço; o launcher marca o processo como não-dumpable, a aplicação retira a chave de `process.env` após a leitura e o ambiente de execução dos scripts não a inclui. Não a adicionar a `policy.json`, Git, argumentos, logs ou imagem.

Instalar a unidade [crontab-ui-agent.service](../deploy/systemd/crontab-ui-agent.service), verificar a delegação cgroup e confirmar que o socket fica em `/run/crontab-ui-agent/agent.sock`, com modo `0660` e grupo dedicado. No contentor, aplicar apenas o overlay correspondente:

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.agent.yml config --quiet
```

Para deployment split, usar `docker-compose.yml`, `docker-compose.split.yml` e `docker-compose.split-agent.yml`. A montagem é apenas de leitura e apenas do directório do socket; nunca montar todo `/run`.

### Instalação e arranque

Compilar wrappers a partir do código revisto, sem `setuid`:

```bash
cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now \
  agent/secure-exec.c -o /usr/local/libexec/crontab-ui-secure-exec
cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now \
  agent/exec-wrapper.c -o /usr/local/libexec/crontab-ui-agent-exec
```

Instalar a unidade em `/etc/systemd/system/`, executar `systemctl daemon-reload` e arrancar primeiro o agente num ambiente de ensaio. Confirmar `systemctl status`, permissões do socket, controllers em `cgroup.controllers`/`cgroup.subtree_control`, e logs de auditoria. Estes comandos não foram executados nesta estação Windows.

### Recuperação e logs

- Cada `operation_id` é persistido antes do processo iniciar. Submissão repetida com o mesmo fingerprint devolve a operação anterior; fingerprint diferente é conflito.
- Após reinício, operações `accepted`/`running` passam a `unknown`; não são reexecutadas automaticamente.
- Resolver `unknown` consultando o estado/log local e o sistema de negócio antes de criar nova operação.
- stdout/stderr ficam em `/var/log/crontab-ui-agent` com nomes UUID, permissões restritas, paginação por cursor e truncagem explícita.
- O estado durável fica em `/var/lib/crontab-ui-agent/agent.db`, separado da SQLite central.
- Cancelamento envia SIGTERM ao grupo e mata o cgroup após o período de graça.
- A conclusão aguarda a limpeza do cgroup: depois de `cgroup.kill`, espera `populated 0` e repete remoções transitoriamente ocupadas, até 2000 ms. Uma falha de limpeza é registada explicitamente e não é reportada como execução bem-sucedida. A validação real da remoção e do prazo continua obrigatória no Ubuntu.

## Backup, restauro e rollback

Os backups SQLite incluem tarefas, destinos, ambientes e histórico de validação. Importar bases legadas sem catálogo cria apenas os destinos locais predefinidos. Em importação/restore, o destino host volta a `unavailable`; não se confia no último estado online guardado no backup.

O merge de importação preserva ambientes existentes; conflito de código ou revisão/runtime incompatível é rejeitado. O replace substitui tarefas e catálogo na mesma transacção. O estado local do agente e processos em execução não são restaurados por um backup central.

Antes de actualizar, criar e verificar backup. Rollback de imagem só é suportado se o esquema for compatível; caso contrário, parar serviços e restaurar backup/imagem compatíveis. Não assumir que voltar à imagem anterior desfaz uma migração.

## Validação operacional

O roteiro [NATIVE_EXECUTION_DRILL.md](NATIVE_EXECUTION_DRILL.md) inclui probes limitados para uma instância Ubuntu independente, critérios separados para execução manual/agendada, cancelamento, timeout, descendentes, CPU/memória/PIDs, idempotência e recuperação. Não executar estes ensaios sobre ETLs ou contas de produção. Os resultados da v0.7.0 estão registados em [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

Os testes Windows cobrem API, migrações, persistência, política, HMAC, named pipes de teste, argv sem shell e fail-closed. Não substituem o ensaio Ubuntu obrigatório de UDS real através de Docker, systemd, cgroups v2, launcher C, restart/reaping e execução de ETL não destrutivo. A feature não deve ser declarada pronta para produção até esse gate passar.
