# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/). Detailed notes per release are in
[docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md).

## [Unreleased]

### Added

- `docs/RELEASE_CHECKLIST.md`: drill record template to keep manual validation evidence per release.
- Execution environment catalog, structured task payloads with argv arrays, and a no-shell structured executor path; legacy `command` tasks remain unchanged.
- Optional Ubuntu local execution agent with UDS/HMAC, independent task allowlist, durable idempotency, cgroup v2 limits, bounded logs and `unknown` recovery state.
- `docs/EXECUTION_ENVIRONMENTS.md`: installation, policy, operations, backup/restore and outstanding Linux validation gates.

### Changed

- `docs/OPERATIONS.md`: the rollback procedure now separates application rollback (keep the volume) from backup restore, matching the release checklist.
- SQLite backups/imports now retain execution environments and structured-task references; legacy databases without a catalog remain importable.

## [0.6.3]

### Added

- `docs/RELEASE_CHECKLIST.md`: publication, operational drill (automated vs manual) and rollback procedure, linked from `docs/OPERATIONS.md`.

### Changed

- Repeated audit write failures are logged to stderr immediately the first time and then at most once every 5 minutes; the alert and the 30-second recovery probe are unchanged.

### Fixed

- The audit alert now resolves, and `/diagnostics` returns to `ok`, once the audit log is writable again; the watchdog retries a write while the audit is failing instead of waiting for unrelated audit activity.
- `docs/OPERATIONS.md` no longer lists real-SMTP rejection as a manual scenario (covered by `tests/mail-smtp.js`).

## [0.6.2]

### Added

- The published Docker schedule is persisted on the data volume and restored at scheduler start; it survives container recreation.
- Optional read-only root filesystem (`docker-compose.readonly.yml`) and `npm run test:docker-resilience` (run in CI).
- Automated tests for a lost scheduler reload acknowledgement, a failing external backup copy and a backup failing with `ENOSPC`.
- Documented the audit retention, rotation and export policy in `docs/OPERATIONS.md`.
- Optional split deployment (`docker-compose.split.yml`): web and scheduler in separate containers sharing the data volume, with a scheduler heartbeat for health and `npm run test:docker-split` (run in CI).
- Integration tests that deliver mail to a real SMTP server, covering a rejected recipient and a successful delivery.
- Operational alerts: a watchdog reports scheduler-down and audit-write failures (stderr, audit event, optional `ALERT_WEBHOOK_URL`); `/diagnostics` exposes `audit` health and reports `degraded`.

### Changed

- The release workflow now waits up to 30 minutes for CI (including the Docker scheduler and recovery tests) and refuses to publish unless it succeeded for the tagged commit; it fails immediately if CI failed.
- Operations guide documents the real level of per-task resource isolation and the release retry procedure.

### Fixed

- Documentation: CHANGELOG comparison links and the README statement that the remote had no published tags.
- An external backup copy failure is now always audited, even when removing the temporary file also fails.

## [0.6.1]

### Added

- Task list filters for last run (success, error, running, never run), schedule state (enabled, disabled) and publication (published, local changes), with a clear button. The filters sit on the same row as the search box and share its styling.

## [0.6.0]

### Added
- Execution state machine (`running`, `completed`, `failed`, `timeout`, `cancelled`,
  `interrupted`, `output_limit`) with final terminal states and idempotent completion.
- `MANUAL_RUN_CONCURRENCY` (`allow`|`forbid`) to control concurrent manual runs of one task.
- Integrity check of every backup before it is published.
- `BACKUP_EXTERNAL_DIR` for a second copy of each backup outside the data volume.
- `/diagnostics` reports the build commit and image version (`GIT_COMMIT`, `IMAGE_VERSION`).
- Tag-triggered release workflow publishing a versioned image with SBOM and provenance.
- Refusal to start as root or with open file permissions in production; per-task resource
  limits; process-tree termination on timeout and cancellation.
- `npm run predeploy` validates authentication, roles, CSRF secret and proxy/TLS settings.
- Compose restart policy, 20 s stop grace period and configurable container CPU, memory and
  PID limits (`CONTAINER_CPUS`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_PIDS_LIMIT`).
- `GET /audit` (administrators) with filters; audit records mask secrets and URL credentials.
- Operations guide: [docs/OPERATIONS.md](docs/OPERATIONS.md).

### Security
- GitHub Actions are pinned by commit SHA.

### Fixed
- Release workflow fixes found by the first run: lowercase GHCR repository, pre-release flag
  for `-` tags, detached descendants terminated on timeout, Alpine packages upgraded and
  lockfile updated for audit findings.
- Docker image no longer embeds local `crontabs/` data from the build context.
- SQLite database is created owner-only (`0600`) and the image restricts data permissions at
  start-up, so the production permission check no longer blocks the Docker deployment.
- `npm run test:docker-recovery`: restore into a clean volume and rollback verification.

### Changed
- Timeouts and output limits are now stored as `timeout` and `output_limit` instead of `failed`.

## [0.5.3]
### Security
- `proxy-addr` updated to 2.0.8 (GHSA-jqcg-44mw-7w3h).

## [0.5.2]
### Fixed
- Scheduled runners receive `COMMAND_TIMEOUT_MS` and `CRON_DB_PATH` explicitly.

## [0.5.1]
### Added
- `ALLOW_HTTP=true` explicit exception for HTTP in production.

[Unreleased]: https://github.com/Kowts/crontab-ui/compare/v0.6.3...HEAD
[0.6.3]: https://github.com/Kowts/crontab-ui/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/Kowts/crontab-ui/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Kowts/crontab-ui/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Kowts/crontab-ui/compare/v0.5.2...v0.6.0
[0.5.3]: https://github.com/Kowts/crontab-ui/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Kowts/crontab-ui/releases/tag/v0.5.2
[0.5.1]: https://github.com/Kowts/crontab-ui/releases/tag/v0.5.1
