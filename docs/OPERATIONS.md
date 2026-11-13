# Operations guide

Applies to v0.6.0 and later. All commands assume Docker Compose deployment; adapt paths for
a native installation.

## Environment variables and defaults

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON`, `CSRF_SECRET` | required | Authentication, roles, CSRF (secret ≥ 32 chars) |
| `TRUSTED_PROXY` / `SSL_CERT`+`SSL_KEY` | none | One is required in production unless `ALLOW_HTTP=true` |
| `COMMAND_TIMEOUT_MS` | `300000` | Task timeout; `0` disables it |
| `COMMAND_MEMORY_LIMIT_MB`, `COMMAND_CPU_SECONDS`, `COMMAND_MAX_PROCESSES` | `0` (off) | Per-task limits |
| `MANUAL_RUN_CONCURRENCY` | `allow` | `forbid` rejects a second manual run of a task with 409 |
| `BACKUP_RETENTION_COUNT` | see `.env.example` | Backups kept locally and in `BACKUP_EXTERNAL_DIR` |
| `BACKUP_EXTERNAL_DIR` | unset | Second copy of each backup outside the data volume |
| `CONTAINER_CPUS`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_PIDS_LIMIT` | `2`, `1g`, `512` | Compose container limits |

`.env.example` is the authoritative list.

## Compatibility

| Component | Supported |
| --- | --- |
| Node.js | 20 and 22 (CI matrix) |
| Docker image | Node 22 Alpine, Supercronic scheduler, runs as `node` |
| Native cron | Linux/POSIX with `crontab`; Windows runs the UI and tests only |

## Pre-deploy and upgrade

1. Read [CHANGELOG.md](../CHANGELOG.md) for the target version.
2. `npm run predeploy` with the production environment loaded.
3. Take a backup (UI or `POST` backup) and confirm it appears in `BACKUP_EXTERNAL_DIR`.
4. Pin the image tag: `IMAGE_VERSION` from `/diagnostics` identifies what is running.
5. `docker compose up -d`; verify `/healthz`, then republish the schedule from the UI.

### Rollback

1. Stop the service: `docker compose stop` (running tasks are cancelled within the grace period).
2. Restore the pre-upgrade backup in the UI, or copy the saved `crontab.db` back into the volume.
3. Start the previous pinned image tag, check `/diagnostics` (`version`, `commit`) and
   republish the schedule. Never roll back by tracking `main`.

Data written by 0.6.0 uses new execution states (`timeout`, `output_limit`, `interrupted`).
Older versions display them as failures; no schema change is required.

## Migration 0.5.x to 0.6.0

- No manual data migration; SQLite history is read as is.
- Running as root in production, or data directories/files open to group/others, now stops the
  service at startup: run as a non-root user and `chmod 700` directories, `chmod 600` files.
- Timeouts and output-limit stops are no longer recorded as `failed`; adjust any external
  reports that filter on status.
- Review the new variables above and run `npm run predeploy`.

## Diagnostics runbook

| Symptom | Check |
| --- | --- |
| Service not starting | Container logs: privilege, permission or transport validation errors name the cause |
| Task did not run | `GET /diagnostics` (loopback, no auth): `scheduler.running` is `false` when Supercronic is down (`status: degraded`; `null` for native cron, which is not observable). Then compare installed vs intended schedule in the UI and republish if different |
| Task fails or stops | Execution history status (`timeout`, `output_limit`, `cancelled`, `interrupted`) and `GET /audit?jobId=<id>` |
| Output missing | Audit event `execution_output` with `status=failed` means the log directory was not writable |
| Email not sent | Audit events for notification; SMTP failures never change the task result |
| Manual run rejected 409 | Another run is active and `MANUAL_RUN_CONCURRENCY=forbid` |

Always quote the `operationId` from the UI error when searching the audit.

## Disaster recovery (new server or container)

1. Deploy the same version (or newer) with the same secrets and roles; run `npm run predeploy`.
2. Start with an empty volume, then restore the latest backup from `BACKUP_EXTERNAL_DIR` via the
   admin restore page (backups are integrity-checked before restore).
3. A restore marks tasks as needing review: confirm them, then publish the schedule, because a
   backup does not prove the host's crontab contains the restored configuration.
4. Verify `/diagnostics`, run one task manually, and check the audit trail.

## Pre-release checklist

1. `npm run lint`, `npm test`, `npm run test:coverage`, `npm audit --omit=dev --audit-level=high`.
2. `npm run test:docker-scheduler` on a Docker-capable runner.
3. Update `CHANGELOG.md`, `docs/RELEASE_NOTES.md`, both READMEs and `package.json` version.
4. Tag `vX.Y.Z` (must equal the `package.json` version); the release workflow builds, scans and
   publishes the image with SBOM and provenance. The `production` GitHub environment must exist.
5. After publishing, check the image's `/diagnostics` and test a rollback to the previous tag.

The release workflow waits up to 30 minutes for CI (including the Docker scheduler and
recovery jobs) to succeed for the tagged commit and fails at once if CI failed. If it fails,
fix the problem and re-run the failed workflow once CI is green, or delete and re-push the tag
(`git push --delete origin vX.Y.Z`) only if the tagged commit itself changes.

## Task resource isolation

Per-task limits (`ulimit` for CPU time, address space and processes) are a safety net, not a
sandbox: `ulimit -v` bounds virtual address space rather than resident memory, and `ulimit -u`
counts processes of the whole `node` user, not of one execution. CPU, memory and PID limits set
in Docker apply to the container as a whole, so tasks share them. Run mutually untrusted tasks
in separate containers; cgroup-based per-task isolation is not part of 0.6.x.

## Manually validated scenarios

Automated: unwritable output directory, SQLite lock held by another process, mailer failing
to start, scheduler rejecting a publication (previous schedule kept, tasks stay unpublished),
service killed with SIGKILL during a manual run (recovered as `interrupted`), restore of a backup into a clean volume (`npm run test:docker-recovery`, run in CI)
and rollback of the data volume to the previous release image (set `RECOVERY_OLD_IMAGE` to a
built image of the previous tag). Not automated (run in a non-production instance before each
minor release): SMTP server rejecting delivery, disk full and container restart with active
tasks (the latter two depend on the host; verify with a size-limited volume and `docker restart`).

A new Docker volume is owned by root unless it is populated from the image: `chown node:node`
the volume root before copying a backup into it. The image tightens permissions of existing
volumes (`go-rwx`) at start-up, as production start-up refuses open permissions.

## Read-only root filesystem (evaluated, not adopted)

`read_only: true` was tried with tmpfs mounts for `/tmp`, `/var/log` and `/etc/crontabs`.
It is not adopted in 0.6.0 for two reasons:

- Supervisor writes `supervisord.log` under `/crontab-ui` by default, so it needs `logfile` and
  `pidfile` pointed at writable paths.
- A tmpfs on `/etc/crontabs` hides the schedule file created in the image and loses the
  published schedule on every restart, while the database still marks tasks as published. A
  safe adoption needs the schedule file to live on the data volume.

Until then the container keeps `cap_drop: ALL`, `no-new-privileges`, an unprivileged user,
limited resources and a `noexec` tmpfs on `/tmp`.

## Scheduling behaviour and examples

- Scheduled runs use Supercronic with default flags: a task is not started again while its
  previous run is still going. Manual runs follow `MANUAL_RUN_CONCURRENCY` (`allow` or `forbid`).
- Each run is bounded by `COMMAND_TIMEOUT_MS` (`0` disables the timeout) and ends as
  `completed`, `failed`, `timeout`, `cancelled`, `output_limit` or `interrupted`.
- After `docker restart` the published schedule file survives (container filesystem); after
  recreating the container it is lost, so publish again. Verify with `GET /diagnostics`
  (`scheduler.running`). Manual runs left running are marked `interrupted`.

Examples (schedule / command):

| Purpose | Schedule | Command |
| --- | --- | --- |
| Nightly cleanup | `0 3 * * *` | `find /data/tmp -type f -mtime +7 -delete` |
| Health ping every 5 minutes | `*/5 * * * *` | `curl -fsS https://example.org/health` |
| Weekly report | `0 8 * * 1` | `node /opt/jobs/report.js` |

Use absolute paths and set `TASK_ENV_ALLOWLIST` for any variable a task needs.

## Standalone installation (without Docker)

1. Install Node.js 20 or 22 and a build toolchain for `better-sqlite3`.
2. Create an unprivileged user, clone the repository at a release tag and run `npm ci --omit=dev`.
3. Copy `.env.example` to `.env.production`; set authentication, roles, `CSRF_SECRET` and
   either TLS or `TRUSTED_PROXY`. Do not run as root.
4. Keep `CRON_DB_PATH` owner-only (`chmod 700`); start with `NODE_ENV=production node bootstrap.js`
   under a service manager (for example systemd with `Restart=on-failure`).
5. Run `npm run predeploy` and check `GET /healthz` and `GET /diagnostics` from loopback.
