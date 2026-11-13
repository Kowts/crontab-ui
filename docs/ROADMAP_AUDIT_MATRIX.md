# Roadmap closure matrix

Maps each area of [ROADMAP_CRONTAB_UI_V0.6.0.md](./ROADMAP_CRONTAB_UI_V0.6.0.md) to its
implementation, automated evidence, result and remaining risk. Updated after v0.6.1.

| # | Requirement | Evidence in code | Test | Result | Risk | Action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Versioned releases, gated on CI | `.github/workflows/release.yml` (waits for CI success on the tagged commit), `CHANGELOG.md`, `docs/RELEASE_NOTES.md` | Exercised by the v0.6.x tags | Done | Gate only runs on a tag push | Require reviewers on the GitHub `production` environment (repository setting) |
| 2 | Task isolation and limits | `execution.js`, `bin/crontab-ui-runner.js` (timeout, output cap, process-tree kill, optional ulimit) | `tests/test.js` "Bounded command execution", "Process tree termination" | Done | `ulimit` is a safety net, not a sandbox | Container limits via Compose; cgroup isolation out of scope for 0.6.x |
| 3 | Scheduler robustness | `scheduler.js` (validate with `supercronic -test`, reload acknowledgement), `lib/schedule-store.js` (persisted schedule restored at start) | `tests/schedule-persistence.js`, `npm run test:docker-scheduler`, `npm run test:docker-resilience` | Done | Native cron is not observable | Documented in `docs/OPERATIONS.md` |
| 4 | Reliable executions and recovery | `crontab.js` / `lib/database.js` (persisted runs, `recoverManualRuns` at bootstrap, concurrency policy) | `tests/test.js` manual-run and bootstrap suites | Done | A crash mid-run is marked `interrupted`, the process may survive | Check the original process before re-running |
| 5 | Backup, restore, DR | Atomic backups, retention, `BACKUP_EXTERNAL_DIR` copy (`crontab.js`) | `tests/test.js` backup suites, `tests/schedule-persistence.js` (external copy failure, `ENOSPC`) | Done | External copy failure is audited, not retried | Monitor audit; periodic restore drill in OPERATIONS.md |
| 6 | Observability and audit | `/diagnostics`, `lib/alerting.js` watchdog, structured audit with rotation (`crontab.js`) | `tests/alerting.js`, diagnostics tests in `tests/test.js` | Done | Alerts depend on an operator-provided webhook | Set `ALERT_WEBHOOK_URL`; see audit retention in OPERATIONS.md |
| 7 | Failure and resilience tests | `scripts/test-docker-resilience.js`, `scripts/test-docker-scheduler.js` | CI jobs (`ci.yml`): recreate, restart, read-only root filesystem + publish | Done | SMTP rejection is covered at unit level only | Add a real SMTP-rejection integration test if mail becomes critical |
| 8 | Dependency security and CI/CD | `ci.yml` (audit, Trivy, coverage thresholds), `.github/dependabot.yml` | CI | Done | New advisories can fail CI at any time | Handle through Dependabot patches |
| 9 | Docker hardening | `Dockerfile` (non-root `node`), `docker-compose.yml` limits, `docker-compose.readonly.yml` | `npm run test:docker-resilience` (read-only mode) | Done | Read-only mode is opt-in | Enable it where the deployment allows |
| 10 | Operational documentation | `docs/OPERATIONS.md`, READMEs (EN/PT) | Review | Done | Docs can drift | Update with each release |
| 11 | Separate web and scheduler | Not implemented | n/a | Deferred | Single container runs both | Revisit after 0.6.x if scaling or isolation requires it |
