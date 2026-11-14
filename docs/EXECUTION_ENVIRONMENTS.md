# Ambientes de execução

## Estado da implementação

O catálogo central, a API administrativa, a página de gestão, as tarefas estruturadas, a validação de payload e o despacho fail-closed estão implementados. O caminho `command` existente permanece separado e continua a usar o executor legado.

A execução structured no contentor requer roots e executáveis allowlisted. `native-local` executa directamente na instalação nativa Linux, sem shell, com wrapper e limites cgroup v2 próprios; em Docker fica indisponível e nunca executa no host. `ubuntu-local` continua a usar o agente host com política independente. Sem configuração válida, todos os destinos falham fechados; não há fallback silencioso.

O serviço e os wrappers C foram implementados, mas esta versão ainda requer validação operacional numa VM Ubuntu: compilação dos wrappers, permissões reais do socket, delegação cgroup v2, reinícios forçados, processos descendentes e cenário ETL de ensaio. Não activar tarefas host de produção antes desses ensaios.

## Catálogo central

1. Iniciar a versão actual da aplicação e criar um backup verificado da SQLite.
2. Entrar como administrador e abrir **Ambientes de execução**.
3. Criar o runtime com path absoluto no namespace do destino; códigos são únicos e imutáveis.
4. Guardar e usar **Validar ambiente**. Um estado `valid` é informativo e não substitui a política do destino.
5. Criar uma tarefa em modo **Estruturado**, seleccionar o ambiente e preencher script, directório de trabalho, argumentos individuais e timeout.
6. Rever a lista de argumentos e o estado do destino; os argumentos nunca são interpretados por shell.

Variáveis de ambiente definidas na tarefa não são suportadas. Não guardar passwords, tokens ou segredos em argumentos, paths ou logs.

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
| `STRUCTURED_EXECUTION_CGROUP_WRAPPER` | Path do wrapper C root-owned que coloca o processo no cgroup antes do `execve`. | vazio |
| `STRUCTURED_EXECUTION_MEMORY_MAX_BYTES` | Memória máxima por execução. | `536870912` |
| `STRUCTURED_EXECUTION_CPU_QUOTA_PERCENT` | Quota CPU por execução; `100` equivale a um CPU. | `100` |
| `STRUCTURED_EXECUTION_PIDS_MAX` | Máximo de processos/threads por execução. | `64` |

Por defeito, executáveis, scripts, roots e directórios pertencentes à conta do serviço são recusados. Se os ETLs existentes forem mantidos por essa mesma conta, o administrador pode definir `STRUCTURED_EXECUTION_TRUSTED_OWNER_UIDS` para UIDs específicos. Esta opção é uma declaração explícita de confiança: os scripts correm com a identidade e acesso a ficheiros da aplicação, não são sandbox e podem alterar outros ficheiros dessa conta. Não adicionar UIDs sem revisão do risco.

O wrapper `agent/exec-wrapper.c` deve ser compilado e instalado root-owned, sem setuid/capacidades, no path configurado:

```bash
cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now \
  agent/exec-wrapper.c -o /usr/local/libexec/crontab-ui-agent-exec
```

A unidade systemd da aplicação tem de delegar `cpu`, `memory` e `pids`; [crontab-ui-native-cgroup.conf.example](../deploy/systemd/crontab-ui-native-cgroup.conf.example) mostra as directivas necessárias. Sem wrapper seguro, controllers delegados ou permissões correctas, a validação e execução são recusadas.

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

## Backup, restauro e rollback

Os backups SQLite incluem tarefas, destinos, ambientes e histórico de validação. Importar bases legadas sem catálogo cria apenas os destinos locais predefinidos. Em importação/restore, o destino host volta a `unavailable`; não se confia no último estado online guardado no backup.

O merge de importação preserva ambientes existentes; conflito de código ou revisão/runtime incompatível é rejeitado. O replace substitui tarefas e catálogo na mesma transacção. O estado local do agente e processos em execução não são restaurados por um backup central.

Antes de actualizar, criar e verificar backup. Rollback de imagem só é suportado se o esquema for compatível; caso contrário, parar serviços e restaurar backup/imagem compatíveis. Não assumir que voltar à imagem anterior desfaz uma migração.

## Limitações de validação

Os testes Windows cobrem API, migrações, persistência, política, HMAC, named pipes de teste, argv sem shell e fail-closed. Não substituem o ensaio Ubuntu obrigatório de UDS real através de Docker, systemd, cgroups v2, launcher C, restart/reaping e execução de ETL não destrutivo. A feature não deve ser declarada pronta para produção até esse gate passar.
