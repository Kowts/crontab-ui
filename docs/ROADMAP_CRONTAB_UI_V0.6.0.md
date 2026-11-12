# Roadmap Técnico — Crontab UI v0.6.0

**Projeto:** [Kowts/crontab-ui](https://github.com/Kowts/crontab-ui)  
**Versão de referência:** 0.5.x  
**Versão-alvo:** 0.6.0  
**Natureza da release:** consolidação técnica, segurança, estabilidade e maturidade operacional.

## Objetivo

Evoluir o Crontab UI para uma versão estável, segura, auditável e preparada para utilização contínua em produção. A versão 0.6.0 deverá priorizar a correção de riscos operacionais, a fiabilidade das execuções, a recuperação de falhas e a disciplina de releases, sem uma reformulação completa da aplicação.

A arquitetura atual, baseada em Node.js, SQLite, Docker, Supercronic e Nginx, deverá ser preservada sempre que possível.

> **Princípio de segurança:** executar uma tarefa equivale a executar o respetivo comando com os privilégios do utilizador do serviço. O RBAC não substitui o isolamento do processo de execução.

## 1. Gestão de versões e releases

**Prioridade:** Crítica.

**Problema:** a versão indicada no `package.json` não garante que o código instalado corresponda a uma release formalmente validada.

**Melhorias:**

1. Criar e manter `CHANGELOG.md`, seguindo Keep a Changelog e Semantic Versioning.
2. Criar tags Git anotadas para cada versão publicada.
3. Publicar GitHub Releases com alterações, correções de segurança, incompatibilidades e instruções de atualização.
4. Automatizar a construção e publicação de imagens Docker versionadas.
5. Identificar imagens por tags específicas e digest SHA-256.
6. Bloquear releases quando lint, testes, auditorias de dependências ou verificações de segurança falharem, salvo exceção formalmente aprovada.
7. Disponibilizar versão, commit Git e identificação da imagem em execução.

**Resultado esperado:** cada instalação identifica exatamente o código executado e permite regressar a uma versão anterior aprovada.

**Critério de aceitação:** instalar e reverter uma release sem depender da branch `main`.

## 2. Segurança e isolamento da execução

**Prioridade:** Crítica.

**Problema:** os comandos shell correm com os privilégios do utilizador do serviço, podendo afetar ficheiros, processos e recursos a que esse utilizador tenha acesso.

**Melhorias:**

1. Garantir que web, scheduler e comandos não executam como `root` em condições normais.
2. Validar privilégios efetivos no arranque e rejeitar configurações inseguras em produção.
3. Aplicar limites de memória, CPU e número de processos quando suportados pelo ambiente.
4. Terminar toda a árvore de processos, e não apenas o shell principal.
5. Impedir que cancelamentos e timeouts deixem processos descendentes ativos.
6. Não transmitir automaticamente segredos e variáveis sensíveis do serviço às tarefas.
7. Restringir permissões de leitura e escrita aos diretórios estritamente necessários.
8. Registar identidade efetiva, motivo de terminação e limites aplicados.

**Resultado esperado:** uma tarefa problemática não compromete facilmente o serviço nem deixa processos órfãos.

**Critério de aceitação:** testes com processos filhos, comandos infinitos, consumo excessivo de recursos e sinais ignorados demonstram aplicação dos limites; limitações de isolamento são documentadas.

## 3. Robustez do scheduler

**Prioridade:** Crítica.

**Problema:** a configuração guardada, a agenda publicada e a configuração efetivamente utilizada pelos runners podem divergir.

**Melhorias:**

1. Transmitir explicitamente `COMMAND_TIMEOUT_MS`, `CRON_DB_PATH` e restantes configurações necessárias aos runners.
2. Validar a configuração antes da publicação.
3. Comparar a agenda pretendida com a efetivamente instalada.
4. Detetar alterações externas e apresentar avisos de divergência.
5. Publicar de forma atómica, preservando a última agenda válida.
6. Confirmar aceitação da nova configuração pelo scheduler antes de declarar sucesso.
7. Tratar reinícios durante a publicação.
8. Impedir interferência indevida entre execuções manuais e agendadas.
9. Documentar comportamento perante sobreposições, falhas e reinícios.

**Resultado esperado:** demonstrar que a agenda publicada corresponde à efetivamente utilizada.

**Critério de aceitação:** falhas simuladas durante a publicação não deixam uma agenda parcial ou silenciosamente divergente.

## 4. Fiabilidade das execuções e recuperação de falhas

**Prioridade:** Alta.

**Problema:** falhas inesperadas, reinícios ou indisponibilidade da base de dados podem originar estados incorretos.

**Melhorias:**

1. Formalizar os estados `pending`, `running`, `success`, `failed`, `timeout`, `cancelled` e `interrupted`.
2. Definir e validar as transições permitidas.
3. Persistir o identificador da execução antes de iniciar o comando.
4. Distinguir falhas, cancelamentos e interrupções por reinício.
5. Recuperar execuções incompletas sem afetar execuções ainda ativas.
6. Tornar idempotente o processamento dos eventos de conclusão.
7. Definir uma política configurável de concorrência para a mesma tarefa.
8. Preservar histórico e logs perante encerramentos inesperados.

**Resultado esperado:** o histórico representa corretamente o que aconteceu, mesmo em cenários de falha.

**Critério de aceitação:** testes de reinício, encerramento forçado e concorrência não geram duplicados, falsos sucessos ou interrupções indevidas.

## 5. Backup, restauro e recuperação de desastre

**Prioridade:** Alta.

**Problema:** possuir backups não garante a recuperação integral do serviço.

**Melhorias:**

1. Definir o conteúdo obrigatório dos backups: base de dados, tarefas, metadados, configurações não secretas e referências necessárias.
2. Garantir backups consistentes da SQLite com o serviço em funcionamento.
3. Validar a integridade dos ficheiros gerados.
4. Implementar restauro com pré-validação, confirmação explícita e recuperação em caso de erro.
5. Criar backup antes de cada operação de restauro.
6. Documentar a recuperação num servidor ou container novo.
7. Definir retenção por quantidade e antiguidade.
8. Suportar armazenamento externo, separado do volume Docker principal.
9. Testar restauro completo, republicação da agenda e funcionamento do scheduler.

**Resultado esperado:** recuperar uma instalação perdida a partir de um backup válido.

**Critério de aceitação:** restaurar tarefas, configurações suportadas, histórico e scheduler numa instalação limpa sem manipulação manual da base de dados.

## 6. Observabilidade, histórico e auditoria

**Prioridade:** Alta.

**Problema:** investigar incidentes exige relacionar execuções com o contexto, ambiente e versão do executor.

**Melhorias:**

1. Normalizar eventos de execução e auditoria em formato estruturado.
2. Registar `executionId`, `taskId`, `trigger`, `startedAt`, `finishedAt`, `duration`, `exitCode` e `terminationReason`.
3. Associar execução a versão, commit, host, PID e hash do executor.
4. Auditar alterações de configuração, publicação, importação, restauro e permissões.
5. Permitir pesquisa e filtragem por tarefa, período, estado e origem.
6. Aplicar rotação e retenção de logs.
7. Evitar exposição de passwords, tokens e variáveis sensíveis em logs e notificações.
8. Distinguir saúde da interface web e saúde do scheduler.
9. Disponibilizar diagnósticos de publicação, scheduler e base de dados.

**Resultado esperado:** investigar falhas sem depender exclusivamente dos logs brutos do container.

**Critério de aceitação:** identificar comando, contexto, resultado, motivo conhecido da terminação e versão responsável, sem expor segredos.

## 7. Testes de resistência e falhas controladas

**Prioridade:** Alta.

**Problema:** testes funcionais não comprovam comportamento correto perante falhas reais de infraestrutura.

**Melhorias:**

1. Testar criação, publicação, execução e registo de resultados de ponta a ponta.
2. Simular encerramento forçado do runner.
3. Reiniciar o container com tarefas ativas.
4. Testar indisponibilidade e bloqueios temporários da SQLite.
5. Simular falta de espaço e diretórios sem permissão de escrita.
6. Testar comandos com output ilimitado.
7. Testar processos filhos que ignoram `SIGTERM`.
8. Simular indisponibilidade SMTP e verificar que os alertas não alteram o resultado da tarefa.
9. Testar falhas de publicação e reload do Supercronic.
10. Executar regressão de autenticação, RBAC, CSRF, importação, restauro e sessões.

**Resultado esperado:** falhas críticas produzem resultados previsíveis, sem corrupção ou perda silenciosa de dados.

**Critério de aceitação:** cenários críticos automatizados; restantes cenários documentados para validação.

## 8. Segurança das dependências e CI/CD

**Prioridade:** Alta.

**Problema:** dependências, imagens e alterações futuras podem introduzir vulnerabilidades.

**Melhorias:**

1. Manter `npm audit` e Trivy na pipeline.
2. Bloquear releases com vulnerabilidades altas/críticas sem exceção aprovada.
3. Atualizar dependências por PRs isolados ou agrupados por risco.
4. Testar compatibilidade nas versões Node.js suportadas.
5. Fixar GitHub Actions e imagens por identificadores imutáveis quando apropriado.
6. Gerar SBOM (*Software Bill of Materials*) para cada release.
7. Publicar relatórios de cobertura e acompanhar regressões.
8. Analisar a imagem Docker final, além do ambiente de desenvolvimento.
9. Separar pipelines de validação e publicação.
10. Exigir aprovação para promoção a produção.

**Resultado esperado:** cada release possui evidências de qualidade, segurança e integridade.

**Critério de aceitação:** uma falha numa verificação obrigatória impede a publicação.

## 9. Hardening do Docker e deployment

**Prioridade:** Média-alta.

**Problema:** a segurança depende da configuração efetiva do container e da infraestrutura.

**Melhorias:**

1. Manter execução normal sem privilégios de root.
2. Preservar `no-new-privileges` e capabilities mínimas.
3. Avaliar filesystem read-only, com volumes explícitos de escrita.
4. Aplicar limites de CPU, memória e processos ao container.
5. Definir políticas de reinício e shutdown controlado.
6. Garantir que só o reverse proxy comunica com a interface web.
7. Validar `TRUSTED_PROXY` e cabeçalhos encaminhados pelo Nginx.
8. Garantir persistência e permissões dos volumes.
9. Criar script de pré-validação do ambiente antes do deployment.
10. Documentar atualização, rollback e migrações de dados.

**Resultado esperado:** deployment reproduzível, previsível e seguro por defeito.

**Critério de aceitação:** instalação nova com configuração oficial passa verificações sem ajustes manuais não documentados.

## 10. Documentação operacional e manutenção

**Prioridade:** Média.

**Problema:** a manutenção torna-se difícil sem procedimentos claros e comportamentos documentados.

**Melhorias:**

1. Manter README em inglês e PT-PT sincronizados.
2. Criar guia de instalação e configuração de produção.
3. Criar runbook de diagnóstico.
4. Documentar backup, restauro, atualização e rollback.
5. Explicar RBAC e riscos de execução de comandos.
6. Criar guia de migração 0.5.x → 0.6.0.
7. Documentar variáveis de ambiente e defaults.
8. Criar matriz de compatibilidade Node.js, Docker e plataformas.
9. Fornecer exemplos de tarefas e configurações recomendadas.
10. Criar checklist de pré-release.

**Resultado esperado:** outro administrador consegue instalar, operar, atualizar e recuperar o serviço sem depender do autor.

**Critério de aceitação:** instalação e recuperação são executáveis apenas com a documentação.

## 11. Arquitetura web/scheduler — evolução futura

**Prioridade:** Futura; não obrigatória para 0.6.0.

**Problema:** web e scheduler partilham o mesmo contexto operacional, limitando a independência dos componentes.

**Proposta:** estudar a separação lógica da interface/API e da execução, preparando interfaces internas claras para uma futura arquitetura:

```text
Web UI / API
     |
     v
Persistência e coordenação (SQLite / pedidos / estados)
     |
     v
Scheduler / Runner
     |
     v
Tarefas, resultados e logs
```

**Decisão recomendada:** manter a arquitetura atual na 0.6.0; considerar separação física dos serviços numa eventual 0.7.0, se a necessidade operacional justificar a complexidade.

## Plano de implementação recomendado

| Fase | Versões propostas | Foco | Entrega |
|---|---|---|---|
| 1 — Segurança e execução | 0.5.4 → 0.5.5 | Isolamento, limites, processos, permissões e scheduler | Execução controlada e agenda consistente |
| 2 — Persistência e recuperação | 0.5.6 → 0.5.7 | Estados, concorrência, backups e recuperação | Recuperação previsível após falhas |
| 3 — Observabilidade e qualidade | 0.5.8 → 0.5.9 | Auditoria, diagnósticos, testes, CI/CD e dependências | Evidências de qualidade e segurança |
| 4 — Release Candidate | 0.6.0-rc.1 | Congelamento de funcionalidades, validação, documentação e migração | Candidato validado |
| 5 — Release estável | 0.6.0 | Aprovação, tag, imagem imutável e deployment | Release oficial controlada |

> As versões intermédias são propostas de organização, não versões já publicadas. Alterações incompatíveis devem ser reservadas para a 0.6.0 ou acompanhadas de mecanismos de compatibilidade.

## Checklist de prontidão para a 0.6.0

- [ ] Execuções sem privilégios elevados e com limites validados.
- [ ] Terminação correta da árvore de processos.
- [ ] Publicação e sincronização do crontab verificadas.
- [ ] Estados de execução e recuperação consistentes.
- [ ] Backups e restauro testados numa instalação limpa.
- [ ] Auditoria e diagnósticos completos.
- [ ] Testes críticos e pipeline CI/CD aprovados.
- [ ] Imagem Docker validada e versionada.
- [ ] Documentação e guia de migração concluídos.
- [ ] Rollback testado e release candidate aprovada.

## Regras de implementação

1. Resolver os pontos por prioridade, preservando compatibilidade sempre que possível.
2. Analisar a implementação existente antes de alterar código, evitando duplicações.
3. Criar testes para cada alteração e executar os testes relevantes e lint.
4. Não considerar uma funcionalidade concluída sem satisfazer o critério de aceitação correspondente.
5. Atualizar a documentação e as notas de release quando o comportamento mudar.
6. Separar alterações por tema; sugerir mensagens Conventional Commits para revisão, sem efetuar commits automaticamente.
7. Evitar adicionar funcionalidades não relacionadas com segurança, estabilidade, recuperação ou observabilidade durante a consolidação.

## Decisão técnica para a 0.6.0

Os pontos **1 a 9** deverão estar concluídos, juntamente com a documentação operacional essencial do ponto **10**. O ponto **11** ficará como preparação arquitetural futura.

Evitar, nesta versão, dashboards complexos, novas integrações, motores de filas distribuídos ou funcionalidades que não contribuam diretamente para a estabilidade e segurança.

**Meta final:** a 0.6.0 deverá oferecer garantias técnicas verificáveis de execução, recuperação, auditoria e deployment, reduzindo a dependência de procedimentos manuais e de conhecimento implícito.
