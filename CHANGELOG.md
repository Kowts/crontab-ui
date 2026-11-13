# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/). Detailed notes per release are in
[docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md).

## [Unreleased]

## [0.6.0]

- Release workflow fixes found by the first run: lowercase GHCR repository, pre-release flag
  for `-` tags, detached descendants terminated on timeout, Alpine packages upgraded and
  lockfile updated for audit findings.

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

[Unreleased]: https://github.com/Kowts/crontab-ui/compare/v0.5.2...HEAD
[0.5.3]: https://github.com/Kowts/crontab-ui/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Kowts/crontab-ui/releases/tag/v0.5.2
[0.5.1]: https://github.com/Kowts/crontab-ui/releases/tag/v0.5.1
