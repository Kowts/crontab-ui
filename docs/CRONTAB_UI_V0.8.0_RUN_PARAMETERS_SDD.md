# Crontab UI v0.8.0 — Especificação de implementação

**Título:** Parâmetros de execução manual para tarefas estruturadas
**Tipo:** SDD / PRD técnico / instruções para agente de desenvolvimento
**Versão do documento:** 1.0 — proposta
**Idioma de implementação e documentação:** português europeu (PT-PT)
**Base funcional:** Crontab UI v0.7.0 (`9170e0c`)
**Repositório:** https://github.com/Kowts/crontab-ui
**Estado:** implementado no ramo `main` (etapas 1–7); ainda não publicado em release

---

## 0. Instruções obrigatórias para a IA implementadora

1. Inspeccionar o repositório e a branch actual antes de alterar código. Este documento descreve a base v0.7.0 observada em 17/11/2026; confirmar ficheiros, funções e linhas citadas na secção 2.
2. Implementar pelas etapas da secção 12, com testes e commits separados. Não fazer uma reescrita global.
3. Preservar integralmente tarefas `command`, tarefas estruturadas sem parâmetros, agendamentos, despacho nativo, agente Ubuntu, histórico, mailing, backups, auditoria e RBAC. Uma tarefa sem `run_parameters` comporta-se exactamente como na v0.7.0.
4. Os valores submetidos nunca passam por shell. São convertidos em elementos de `argv` e entregues ao executor estruturado existente (`spawn` sem shell).
5. O utilizador fornece **valores**, não argumentos. Nenhum pedido pode acrescentar flags, tokens ou caminhos que não estejam definidos na tarefa.
6. Não alargar a política do agente Ubuntu. Nesta versão, `ubuntu-local` recusa tarefas com parâmetros (secção 3, decisão D4).
7. Não executar scripts ETL de produção nem argumentos destrutivos em testes. Usar fixtures sintéticas.
8. Não declarar testes aprovados sem os executar e apresentar resultados. Não fazer deploy, tag ou release sem aprovação explícita.
9. As decisões da secção 14 foram aprovadas; novas questões devem ser acrescentadas aí e resolvidas com o responsável antes da etapa afectada.

## 1. Contexto e problema

Uma tarefa estruturada guarda hoje uma lista fixa de argumentos. Para reprocessar um dia específico, um operador tem de editar a tarefa, alterar os argumentos, executar e repor a configuração — o que altera a definição permanente, obriga a nova publicação e não deixa claro no histórico que valores foram usados.

Exemplo: o processo *Pagamentos Siebel* corre diariamente sem argumentos, mas aceita `--date AAAA-MM-DD`, `--delete`, `--deleteAll` e `--no-mail` para reprocessamento manual.

### 1.1 Resultados esperados

- O administrador define, na tarefa estruturada, os parâmetros aceites na execução manual e o respectivo tipo de campo.
- Ao carregar em **Executar**, o utilizador preenche um formulário gerado a partir dessa definição e vê a pré-visualização do `argv` final.
- O servidor valida novamente cada valor, compõe o `argv` de forma determinística e executa pelo caminho estruturado existente.
- Os valores efectivos ficam no histórico de execuções e na auditoria; a execução pode ser repetida com os mesmos valores.
- Opções destrutivas exigem confirmação explícita e podem exigir um perfil mínimo.

### 1.2 Fora do âmbito

- Parâmetros em execuções agendadas (o agendamento usa apenas os argumentos fixos).
- Parâmetros em tarefas `command` (caminho com shell).
- Suporte em `ubuntu-local` (exige evolução da política do agente; ver secção 13).
- Templates reutilizáveis entre tarefas e catálogo global de parâmetros.
- Dependências entre parâmetros (`requires`, `conflictsWith`); o script continua responsável por validar combinações.
- Datas relativas (`today`, `yesterday`), tipo password ou qualquer campo para segredos.
- Variáveis de ambiente definidas por execução.

## 2. Factos observados no código v0.7.0 e pontos de integração

| Local | Facto | Impacto |
| --- | --- | --- |
| `config/structured-tasks.js` | `validateStructuredTask` aceita apenas `environment_id`, `script_path`, `working_directory`, `arguments`, `timeout_ms`, `environment_variables`; limita `arguments` a 100 elementos, 4096 caracteres cada e 16000 no total | Acrescentar `run_parameters` ao conjunto de campos e validá-lo aqui |
| `crontab.js` (`buildCrontab`, ~l.106–111) | A definição estruturada é guardada em `job.structured_execution` dentro do documento JSON da tarefa | `run_parameters` fica no documento; sem migração da tabela `jobs` |
| `lib/native-dispatch.js` (`scheduledFingerprint`, ~l.53) | O fingerprint do agendamento nativo inclui `structured_execution` completo | Alterar o schema invalida o fingerprint e exige nova publicação — comportamento desejado |
| `crontab.js` (`prepareJobExecution`, ~l.604) | Ramo `ubuntu-local` constrói o pedido do agente com `definition.arguments`; outros destinos usam `prepareStructuredExecution` | Ponto onde se injectam os argumentos de execução e se recusa `ubuntu-local` |
| `lib/structured-execution.js` (~l.351) | `args: [script.path, ...structured.arguments]` | Passar a aceitar argumentos de execução adicionais, já validados |
| `crontab.js` (`startManualRun`, ~l.830) | Recebe `(_id, auditContext, callback)`; regista `manual_run` na auditoria e `recordExecution` no fim | Acrescentar `runParameters`; registar valores no histórico e na auditoria |
| `app.js` (~l.673) | `POST /runjob` com `requireRole('executor')`, `validateIdParam`, `requireJobAccess('execute')` | Aceitar `parameters` e `confirmed`; aplicar `min_role` por parâmetro |
| `app.js` (~l.236–237) | `express.json` e `express.urlencoded` com limite de 32 kB | O formulário deve enviar JSON para preservar booleanos |
| `lib/database.js` (`executions`, ~l.74; migração `runtime_metadata`, ~l.108) | Colunas adicionadas por `ALTER TABLE` condicional; migrações versionadas `0001`–`0003` | Nova migração `0004_execution_run_parameters` |
| `lib/local-agent-policy.js` (~l.91) | Argumentos do agente validados por posição, com lista de comprimento fixo | Incompatível com flags opcionais; justifica D4 |
| `crontab.js` (importação, ~l.1125) | Campos aceites na importação incluem `structured_execution` | Backup/restore transportam `run_parameters` sem novos campos de topo |
| `public/js/script.js` (`runJob`, ~l.389) | `$.post(routes.run, {_id})` em formulário URL-encoded | Abrir modal quando a tarefa tem parâmetros; enviar JSON |
| `views/popup.ejs` (~l.10–19) | Secção estruturada com lista de argumentos e pré-visualização | Acrescentar a secção **Parâmetros de execução** |

## 3. Decisões de arquitectura

| # | Decisão | Justificação |
| --- | --- | --- |
| D1 | A tarefa é proprietária da definição; cada execução é proprietária dos valores | A execução manual não altera a configuração permanente |
| D2 | A definição fica em `structured_execution.run_parameters` | Reaproveita validação, backup, importação, revisão e fingerprint existentes |
| D3 | Só execução manual | O despacho agendado mantém o contrato `{operation_id, task_id, fingerprint}`; nada muda na linha cron |
| D4 | `ubuntu-local` recusa tarefas com `run_parameters` (ao guardar e ao executar) | A política do agente é uma fronteira independente e valida argumentos por posição; o schema da UI não a pode alargar |
| D5 | Tipos fechados e valores restritos | Evitar injecção de argumentos mesmo sem shell (ex.: valor `--deleteAll` num campo de texto) |
| D6 | `argv = [script, ...arguments fixos, ...tokens dos parâmetros pela ordem da definição]` | Ordem determinística, previsível e auditável |
| D7 | O servidor aplica os valores por omissão a chaves omitidas | O pedido HTTP e a UI produzem o mesmo resultado |

## 4. Modelo de domínio

### 4.1 Definição de parâmetro

```json
{
  "run_parameters": [
    { "name": "date", "flag": "--date", "type": "date", "label": "Data de processamento",
      "help": "Vazio: o script decide a data.", "required": false, "style": "separate" },
    { "name": "delete", "flag": "--delete", "type": "flag", "label": "Apagar registos existentes",
      "default": false, "confirm": true, "min_role": "operator" },
    { "name": "delete_all", "flag": "--deleteAll", "type": "flag", "label": "Apagar todos os registos",
      "default": false, "confirm": true, "min_role": "admin" },
    { "name": "no_mail", "flag": "--no-mail", "type": "flag", "label": "Não enviar e-mail", "default": false }
  ]
}
```

| Campo | Regra |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,31}$`, único na tarefa |
| `flag` | `^--?[A-Za-z0-9][A-Za-z0-9-]{0,62}$`, único; não pode coincidir com um token dos argumentos fixos |
| `type` | `flag`, `date`, `select`, `integer` ou `text` |
| `label` | 1–80 caracteres, sem quebras de linha |
| `help` | opcional, até 200 caracteres |
| `required` | booleano; proibido em `flag` |
| `default` | opcional; validado com as regras do tipo |
| `style` | `separate` (`--date`, `2026-11-15`) ou `equals` (`--date=2026-11-15`); proibido em `flag`; por omissão `separate` |
| `confirm` | booleano; exige confirmação explícita quando o parâmetro está activo |
| `min_role` | `executor`, `operator` ou `admin`; por omissão `executor` |

Limites: no máximo 20 parâmetros por tarefa; campos desconhecidos são recusados; o `argv` final continua sujeito aos limites de `validateStructuredTask` (100 elementos, 16000 caracteres).

### 4.2 Tipos e valores

| Tipo | Campos próprios | Valor aceite | Tokens emitidos |
| --- | --- | --- | --- |
| `flag` | — | booleano JSON | `[flag]` se `true`; nada se `false` |
| `date` | `min`, `max` opcionais (`AAAA-MM-DD`) | data de calendário válida `AAAA-MM-DD` | conforme `style` |
| `select` | `options`: 1–50 `{ value, label }`, valores únicos | um dos `value` definidos | conforme `style` |
| `integer` | `min` e `max` obrigatórios | inteiro seguro dentro do intervalo | conforme `style` |
| `text` | `pattern` obrigatório (âncoras implícitas), `max_length` até 256 | string que cumpre o padrão | conforme `style` |

Regras comuns aos valores de `select` e `text`: não podem começar por `-`, conter `\0`, `\r` ou `\n`. Os `value` de `select` são validados na definição com `^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]{0,127}$`. O padrão de `text` é compilado na definição; padrões inválidos ou com mais de 256 caracteres são recusados.

Um parâmetro está **activo** quando emite pelo menos um token. Um campo opcional vazio (`""` ou `null`) não está activo e não emite tokens.

### 4.3 Composição

Módulo novo `config/run-parameters.js`, sem dependências de I/O:

- `validateRunParameterDefinitions(definitions, fixedArguments)` → definição normalizada ou erro 422.
- `resolveRunParameters(definitions, submitted)` → `{ values, tokens, active }`; recusa chaves desconhecidas, tipos errados e obrigatórios em falta (422).
- Funções puras, testáveis isoladamente.

## 5. Persistência

- **Tarefas:** sem migração; `run_parameters` vive em `structured_execution` no documento JSON.
- **Execuções:** migração `0004_execution_run_parameters` acrescenta `executions.run_parameters TEXT` (JSON `{ name: valor }` apenas dos parâmetros activos; `NULL` em execuções agendadas ou sem parâmetros). Seguir o padrão transaccional das migrações existentes.
- **Backup/restore/importação:** `run_parameters` é transportado em `structured_execution` e revalidado por `validateStructuredTask`. Backups v0.7.0 sem o campo continuam válidos.
- **Rollback para v0.7.0:** a v0.7.0 recusa `run_parameters` como campo desconhecido. Remover os parâmetros antes do downgrade ou restaurar um backup anterior; documentar em `docs/OPERATIONS.md`.

## 6. API HTTP

### 6.1 Execução manual

`POST /runjob` (JSON):

```json
{ "_id": "…", "parameters": { "date": "2026-11-15", "delete": true }, "confirmed": ["delete"] }
```

Ordem de verificação:

1. Middleware existente (`executor`, `validateIdParam`, `requireJobAccess('execute')`, CSRF).
2. Tarefa sem `run_parameters`: `parameters` tem de estar ausente ou vazio, caso contrário 422. Comportamento v0.7.0 mantido.
3. `resolveRunParameters` com valores por omissão (D7).
4. Para cada parâmetro activo com `min_role` acima do perfil do utilizador: 403 `RUN_PARAMETER_FORBIDDEN`.
5. O conjunto `confirmed` tem de ser exactamente igual ao conjunto de parâmetros activos com `confirm: true`: caso contrário 409 `RUN_PARAMETER_CONFIRMATION_REQUIRED`, com a lista em falta.
6. Destino `ubuntu-local`: 409 `RUN_PARAMETERS_UNSUPPORTED_TARGET` (defesa em profundidade da D4).
7. `startManualRun(_id, auditContext, callback, { runParameters })`.

O pedido URL-encoded sem `parameters` continua aceite para tarefas sem parâmetros.

### 6.2 Gravação da tarefa

`POST /save` com `structured_execution.run_parameters`:

- 422 se a definição for inválida ou colidir com argumentos fixos.
- 422 `RUN_PARAMETERS_UNSUPPORTED_TARGET` se o ambiente for `ubuntu-local`.
- A alteração segue o fluxo actual (`saved: false`), exigindo nova publicação.

### 6.3 Histórico

Cada entrada de `history` em `GET /executions` passa a incluir `runParameters` (objecto com os valores activos, ou `null`), seguindo a convenção camelCase das restantes propriedades da resposta.

## 7. Segurança e RBAC

- Nenhum caminho com shell recebe valores. Tarefas `command` não aceitam `run_parameters`.
- Valores fechados por tipo; `text` exige padrão; valores não podem começar por `-` (D5).
- `min_role` é verificado no servidor; a UI apenas reflecte o resultado.
- A confirmação é verificada no servidor; a UI não pode contorná-la.
- Os valores ficam no histórico e na auditoria; a UI avisa que não se devem introduzir segredos.
- A propriedade (ownership) e `ALLOW_OPERATOR_TASK_EXECUTION` mantêm a semântica actual.
- O e-mail de notificação não inclui os valores (mantém a regra de não expor o comando).

## 8. Interface

### 8.1 Editor da tarefa

No modo **Estruturado**, abaixo de **Argumentos**, uma secção opcional **Parâmetros de execução manual**:

- Tabela de parâmetros com nome técnico, etiqueta, tipo, obrigatório, valor por omissão, confirmação e perfil mínimo; acções para adicionar, editar, reordenar e remover.
- Campos específicos aparecem conforme o tipo (opções de `select`, intervalo de `integer`, padrão de `text`, intervalo de `date`).
- A pré-visualização existente passa a mostrar os argumentos fixos e um exemplo com os valores por omissão.
- Com um ambiente `ubuntu-local`, a secção fica desactivada com explicação.

### 8.2 Modal de execução

Quando a tarefa tem parâmetros, **Executar** abre um modal em vez de executar de imediato:

- Cabeçalho com nome da tarefa, runtime e destino.
- Um controlo por parâmetro: `date` → `<input type="date">`, `flag` → checkbox, `select` → `<select>`, `integer` → `<input type="number">`, `text` → `<input type="text">` com `pattern`.
- Parâmetros acima do perfil do utilizador ficam desactivados, com a indicação do perfil necessário.
- Pré-visualização do `argv` em tempo real (só informativa; o servidor recompõe).
- Se houver parâmetros activos com `confirm`, aparece um bloco de aviso com uma checkbox de confirmação por parâmetro; **Executar** fica desactivado até estarem todas marcadas.
- Erros do servidor (422/403/409) são apresentados junto dos campos e o modal não fecha.
- Após o 202, o acompanhamento segue o fluxo actual (`trackManualRun`).

Tarefas sem parâmetros mantêm a execução directa.

### 8.3 Histórico

- O painel de execuções mostra os parâmetros activos de cada execução manual (ex.: `--date 2026-11-15 --delete`).
- Acção **Repetir com estes valores**: abre o modal preenchido; os valores são revalidados com a definição actual e os que já não forem válidos são assinalados.

### 8.4 Regras partilhadas com o browser

O browser usa o mesmo módulo `config/run-parameters.js` que o servidor, servido em `/vendor/run-parameter-rules.js` (embrulhado uma vez no arranque e exposto como `window.CrontabRunParameterRules`). A pré-visualização e os erros junto dos campos são, por isso, os mesmos que o servidor produz. O cliente vive em `public/js/run-parameters.js` (`window.CrontabRunParameters`) e é opcional para `public/js/script.js`. O perfil actual chega ao cliente em `#role-state`, apenas para reflectir o resultado na interface.

### 8.5 Acessibilidade e i18n

Rótulos visíveis, `aria-describedby` para ajuda e erros, foco inicial no primeiro campo, navegação por teclado. Todas as strings novas em `config/i18n.js` (EN e PT). As etiquetas definidas pelo administrador não são traduzidas.

## 9. Auditoria

- O evento `manual_run` (`started` e terminal) inclui `parameters` (valores activos) e `parametersDigest` (SHA-256 do JSON canónico).
- Recusas por `min_role`, confirmação ou destino geram evento `manual_run` com `status: 'rejected'` e o código de erro, sem executar.
- `execution_dispatch` não muda.

## 10. Compatibilidade

| Cenário | Comportamento |
| --- | --- |
| Tarefa `command` | Inalterada; `run_parameters` não existe |
| Tarefa estruturada sem `run_parameters` | Inalterada; execução directa |
| Agendamento de tarefa com parâmetros | Usa só os argumentos fixos; `executions.run_parameters` = `NULL` |
| Base v0.7.0 | Migração `0004` aditiva; execuções antigas com `NULL` |
| Backup v0.7.0 restaurado na v0.8.0 | Aceite sem alterações |
| Downgrade para v0.7.0 | Ver secção 5 |

## 11. Testes

**Unitários (`config/run-parameters.js`):**
- Definições válidas e inválidas para cada tipo; nomes e flags duplicados; colisão com argumentos fixos; padrões inválidos; limites de 20 parâmetros.
- Valores: tipos errados, chaves desconhecidas, obrigatórios em falta, datas impossíveis (`2026-02-30`), intervalos, valores iniciados por `-`, `\0` e quebras de linha.
- Composição: ordem determinística, `separate` vs `equals`, flags inactivas, valores por omissão, limites finais do `argv`.

**Integração (supertest):**
- `POST /runjob` com JSON válido produz o `argv` esperado (executor estruturado com fixture que imprime `sys.argv`/`process.argv`).
- 422, 403, 409 (`CONFIRMATION_REQUIRED`, `UNSUPPORTED_TARGET`) sem criar execução.
- Tarefa sem parâmetros: pedido URL-encoded antigo continua a funcionar; `parameters` não vazio → 422.
- CSRF e RBAC existentes continuam aplicados.
- Gravação: definição inválida e `ubuntu-local` → 422; alteração marca `saved: false` e altera o fingerprint nativo.
- Histórico e auditoria contêm os valores; agendamento regista `NULL`.
- Migração `0004` sobre base v0.7.0; backup/restore e importação com e sem `run_parameters`.

**Frontend (padrão de `tests/execution-environments-panel.js`):**
- Modal gerado a partir da definição; pré-visualização; bloqueio por confirmação; campos desactivados por perfil; **Repetir com estes valores**.

**Regressão:** suite completa, `npm run lint`, `git diff --check`, testes Docker existentes.

## 12. Etapas de implementação

Cada etapa num commit separado, com testes:

1. `config/run-parameters.js` e testes unitários.
2. Integração em `validateStructuredTask`, gravação (`/save`), recusa `ubuntu-local`, importação e backup.
3. Execução: `prepareJobExecution`/`prepareStructuredExecution` com argumentos de execução; `startManualRun` com `runParameters`; migração `0004`; auditoria.
4. API `POST /runjob` com JSON, `min_role` e confirmação; `GET /executions` com `run_parameters`.
5. UI do editor (secção de parâmetros).
6. UI do modal de execução, histórico e **Repetir com estes valores**.
7. i18n EN/PT, `README.md`, `README.pt-PT.md`, `docs/EXECUTION_ENVIRONMENTS.md`, `docs/OPERATIONS.md` (downgrade), `CHANGELOG.md`.

## 13. Evolução prevista (fora da v0.8.0)

- **Agente Ubuntu:** a política root-managed passa a declarar o mesmo schema de parâmetros por tarefa; o agente valida os valores contra a sua cópia, e não contra o pedido.
- **Parâmetros agendados:** valores fixos por agendamento, incluídos no fingerprint.
- **Templates de execução** reutilizáveis entre tarefas.
- **Datas relativas** com fuso horário explícito.

## 14. Decisões e bloqueios

Decisões aprovadas pelo responsável em 17/11/2026:

| # | Questão | Decisão |
| --- | --- | --- |
| Q1 | Parâmetros acima do perfil: esconder ou mostrar desactivados? | Mostrar desactivados, com o perfil necessário |
| Q2 | Confirmação: checkbox por parâmetro ou escrever o nome da tarefa? | Checkbox por parâmetro |
| Q3 | Incluir os valores no e-mail de notificação? | Não |
| Q4 | Uma tarefa com parâmetros obrigatórios pode estar agendada? | Sim; o agendamento ignora os parâmetros. A UI avisa que obrigatório só se aplica à execução manual |
| Q5 | `min`/`max` de `date` absolutos são suficientes? | Sim nesta versão |

## 15. Critérios de aceitação

- [ ] Tarefas `command` e estruturadas sem parâmetros sem qualquer alteração de comportamento (testes de regressão).
- [ ] Definição validada ao gravar, importar e restaurar; alteração exige nova publicação.
- [ ] Modal de execução gerado a partir da definição, com pré-visualização e validação.
- [ ] O servidor recusa chaves desconhecidas, valores inválidos, perfil insuficiente e confirmação em falta, sem iniciar a execução.
- [ ] `argv` composto pela ordem definida, sem shell, verificado com fixture.
- [ ] `ubuntu-local` recusa parâmetros ao gravar e ao executar.
- [ ] Valores efectivos no histórico e na auditoria; agendamentos com `NULL`.
- [ ] Migração `0004` aditiva; backups v0.7.0 restauráveis.
- [ ] i18n EN/PT e documentação actualizadas.
- [ ] Lint, suite completa e CI aprovados no commit candidato.
