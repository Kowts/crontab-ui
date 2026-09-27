# Troubleshooting and recovery

## The application is not reachable

First confirm the process/container, the loopback connection, and the reverse proxy. The service must not be directly exposed to the Internet.

```bash
docker compose ps
docker compose exec crontab-ui curl -fsS http://127.0.0.1:8000/healthz
```

`/healthz` does not require credentials, but accepts loopback connections only. The image installs `curl`, so the command above is valid inside the container; the port is available on the host only when the development overlay is explicitly used.

If the health check fails, review container logs and `crontab-data` volume permissions. Do not run the application as `root` to bypass permissions; grant only the service user access to the persistent directory and isolated scheduling mechanism.

## Publishing to or importing from crontab failed

These operations require a Unix/Linux system with the `crontab` executable and appropriate permissions on the staging directory configured by `CRON_PATH`. Check the audit ID shown in the interface and `crontabs/logs/operations.jsonl`.

A publishing failure restores the previous environment and staging file. Fix the cause and publish again; do not edit `crontab.db` manually.

## Recovering a configuration

Do not use `crontab-ui --reset` as a recovery mechanism. Preserve the data volume, suspend public access, and restore only a recognized backup through the administrative **Backups** area. See the complete procedure in the [main README](../README.md#backups-recovery-and-audit).

## Email problems

SMTP data is server-only in `MAIL_PROFILES_JSON`. Verify the profile identifier, SMTP network access, and audit log. Never enter SMTP passwords in a task, browser, or tracked file.
