# Diagnóstico e recuperação

## A aplicação não está acessível

Confirme primeiro o processo/contentor, a ligação em loopback e o reverse proxy. O serviço não deve ser exposto directamente à Internet.

```bash
docker compose ps
docker compose exec crontab-ui curl -fsS http://127.0.0.1:8000/healthz
```

`/healthz` não requer credenciais, mas aceita apenas ligações loopback. A imagem instala `curl`, pelo que o comando acima é válido dentro do contentor; a porta só fica disponível no anfitrião quando for usada explicitamente a sobreposição de desenvolvimento.

Se o healthcheck falhar, reveja os logs do contentor e as permissões do volume `crontab-data`. Não execute a aplicação como `root` para contornar permissões; atribua apenas ao utilizador do serviço acesso ao directório persistente e ao mecanismo de agendamento isolado.

## A publicação ou importação do crontab falhou

Estas operações requerem um sistema Unix/Linux com o binário `crontab` e permissões adequadas no directório de staging configurado por `CRON_PATH`. Consulte o ID de auditoria apresentado pela interface e o diário `crontabs/logs/operations.jsonl`.

Uma falha de publicação restaura o ambiente e o ficheiro de staging anteriores. Corrija a causa e publique novamente; não edite `crontab.db` manualmente.

## Recuperar uma configuração

Não use `crontab-ui --reset` como mecanismo de recuperação. Preserve o volume de dados, suspenda o acesso público e restaure apenas uma cópia reconhecida através da área administrativa **Backups**. Consulte o procedimento completo no [README principal](../README.md#backups-recuperação-e-auditoria).

## Problemas de correio

Os dados SMTP são exclusivos do servidor em `MAIL_PROFILES_JSON`. Confirme o identificador do perfil, o acesso à rede SMTP e o diário de auditoria. Nunca introduza palavras-passe SMTP na tarefa, no browser ou num ficheiro versionado.
