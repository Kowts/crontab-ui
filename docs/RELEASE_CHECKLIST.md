# Release checklist

Procedure for publishing a Crontab UI release. Operational background (rollback, disaster
recovery, diagnostics) is in [OPERATIONS.md](OPERATIONS.md). A release is authorised only when
every mandatory item is done, the operational drill passed, no critical or high issue is open and
the rollback procedure below is executable.

Automated checks demonstrate that the recovery mechanisms work in a controlled environment; the
manual drill confirms that a recovered instance works in the real environment. One does not
replace the other.

## 1. Before tagging

- [ ] `CHANGELOG.md`: `[Unreleased]` renamed to `[X.Y.Z]`, a new empty `[Unreleased]` added and the compare links updated.
- [ ] `docs/RELEASE_NOTES.md` has a section for the version, consistent with the changelog; both READMEs are current.
- [ ] `package.json` and `package-lock.json` version equals the planned tag (`npm version X.Y.Z --no-git-tag-version`).
- [ ] `npm run lint`, `npm test`, `npm run test:coverage`, `npm audit --omit=dev --audit-level=high` pass.
- [ ] CI is green for the exact commit that will be tagged (including the Docker scheduler, recovery, resilience and split jobs).
- [ ] Structured execution is disabled by default; if included in the release, container allowlists and Linux no-shell tests pass.
- [ ] If the Ubuntu agent is included/enabled, its independent host policy, HMAC/UDS, cgroup v2 limits, restart/unknown recovery, cancellation and ownership adversarial tests pass on an Ubuntu VM.
- [ ] Structured task catalog, import/restore and legacy command compatibility are verified with a production-like backup.
- [ ] If enabling `AUTH_PROVIDER=sqlite`, environment-user migration, last-admin protection, session revocation, recovery CLI and rollback to retained legacy `env` configuration are verified.
- [ ] A pre-release backup of the running instance exists and is also in `BACKUP_EXTERNAL_DIR`.
- [ ] Native structured tasks have a verified cron-to-delegated-executor dispatch path: authenticated and authorised requests, unique operation IDs, idempotency and no automatic retry of unknown results.
- [ ] A reviewer is available to approve the `production` environment deployment.

## 2. Operational drill

Run on an instance that is not production, ideally on a different server.

For the Native Linux rows, use the bounded fixtures and per-trigger evidence criteria in
[NATIVE_EXECUTION_DRILL.md](NATIVE_EXECUTION_DRILL.md). Test artifacts are not operational
proof; retain the actual Ubuntu outputs before checking these items.

| Step | Covered automatically | Manual |
| --- | --- | --- |
| Create a backup and verify its integrity | Backup suites in `npm test` (`PRAGMA integrity_check`) | Confirm the file also arrived in `BACKUP_EXTERNAL_DIR` on a different volume |
| Restore into a clean volume | `npm run test:docker-recovery` (CI) | Restore on the independent server with its real storage and credentials |
| Roll the data volume back to the previous image | `npm run test:docker-recovery` with `RECOVERY_OLD_IMAGE` set to the previous tag | Repeat with the real previous image |
| Users, roles and permissions | - | Sign in with each role and confirm access |
| Configuration, environment variables and secrets | - | Compare with the production configuration; run `npm run predeploy` |
| Scheduled tasks recovered | `npm run test:docker-resilience` (CI) | Confirm the tasks are listed, review them and republish the schedule |
| Tasks actually run in the scheduler | `npm run test:docker-scheduler` (CI) | Create a test task, wait for a scheduled run and confirm it as the non-root user |
| Logs, history and audit | - | Check the execution history, `GET /audit` and the `logs` directory |
| Structured container execution | Unit/API tests | On Linux, execute a non-destructive sample under configured executable/root allowlists |
| Native structured execution | Policy/API tests | On Ubuntu, verify both manual and cron-triggered dispatch under the delegated systemd unit; confirm UID, interpreter, working directory and distinct execution cgroups |
| Native resource control and recovery | Executor/policy tests | For both triggers, test timeout, cancellation, surviving descendants, memory/CPU/PID limits and service restart; verify no orphan processes, no duplicate execution and explicit interrupted/unknown results |
| Ubuntu agent and UDS | HMAC/policy unit tests | On an independent Ubuntu VM, validate socket permissions, replay rejection, cgroup limits, cancellation and agent restart reconciliation |
| Structured recovery | SQLite snapshot/import tests | Restore a backup and reconcile agent-local state; confirm `unknown` is never automatically resubmitted |

Record the result, date, environment and who ran the drill (for example in the release pull
request or issue). If anything fails, fix it and repeat the affected steps.

Copy this template for each release and fill in only what was actually tested manually:

```markdown
### Drill record - vX.Y.Z

- Date:
- Environment (independent server / volume):
- Image or version tested (tag and digest):
- Run by:
- Backup and integrity, external copy:        pass / fail / not tested
- Restore into a clean volume:                pass / fail / not tested
- Rollback to the previous image:             pass / fail / not tested
- Users, roles and permissions:               pass / fail / not tested
- Configuration and secrets (`predeploy`):    pass / fail / not tested
- Scheduled tasks recovered:                  pass / fail / not tested
- Task executed by the scheduler:             pass / fail / not tested
- Logs, history and audit:                    pass / fail / not tested
- Notes and limitations:
```

## 3. Publish

1. Commit and push; wait for green CI on that commit.
2. Create and push the annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push origin vX.Y.Z`.
3. The release workflow waits for CI, then pauses on the `production` environment: the reviewer must approve it in the run page (*Review deployments*).
4. Wait for the workflow to build, scan and publish the image with SBOM and provenance.

## 4. After publishing

- [ ] The image is identified by its digest (shown in the release body) and the digest matches what you deploy.
- [ ] `/healthz` responds and `/diagnostics` reports the expected `version` and `commit` with `status: ok`.
- [ ] Container logs show no unexpected errors; the schedule has been republished from the UI if required.
- [ ] The GitHub release has an English title (`vX.Y.Z - Summary`) and English notes (`gh release edit`).
- [ ] The tag, the image and the package version are the same version.

## 5. Rollback

Choose the situation first. Changing the image does not undo changes already written to the
database or other persistent files.

- **Application rollback** (the problem is in the code and the stored data is compatible): deploy the previous image tag or digest on the current volume, check `/diagnostics` (`version`, `commit`) and republish the schedule. Data written by newer versions is read as is unless the release notes state otherwise.
- **Backup restore** (corruption, an incompatible migration or an irreversible state change): stop the service, deploy the previous pinned image, restore the pre-release backup (UI restore or copying `crontab.db` back), then review and republish the tasks as described in *Rollback* and *Disaster recovery* in [OPERATIONS.md](OPERATIONS.md).

Never roll back by tracking `main`. If the release workflow itself fails after CI succeeded,
re-run the failed workflow; delete and re-push the tag (`git push --delete origin vX.Y.Z`) only if
the tagged commit changes.

## 6. Drill records

### v0.7.0 execution-environment gate

- Production decision (2026-11-17): maintainer explicitly approved production and waived remaining operational drills, accepting the risk. This supersedes the earlier publication-only exception. Preserve the actual evidence below: unperformed checks are waived, not technical passes. Automated release workflow checks and environment approvals remain enforced.
- Status: **approved for production by maintainer risk acceptance; remaining operational drills waived**
- Required before release: an independent Ubuntu VM drill covering the rows above, with environment, image digest, date, operator and outputs recorded.
- The Windows development session validates JavaScript, API, SQLite, HMAC and policy logic only; it does not prove Linux UDS permissions, C wrapper compilation, systemd delegation or cgroup behaviour.

#### Isolated Native Linux drill reported on 2026-11-16

- Environment: Ubuntu 24.04.4, kernel 6.8.0-136-generic, systemd 255.4, Node 20.20.0, Python 3.12; independent validation service and database, not production.
- Cleanup fix tested: `2e3c4c24c5f0b65c97daf74ba332658967d77471`. The runtime still reports package version 0.6.3; no v0.7.0 tag or image is approved by these results.
- Manual and cron-triggered samples passed interpreter, working-directory, UID 994 and delegated execution-cgroup checks. Configured limits: 64 MiB RAM, 25% CPU and 8 PIDs.
- Timeout, descendant termination, parent-exit cleanup, CPU quota, PID exhaustion, cancellation and graceful service stop passed for both triggers. Measured parent-exit cgroup removal after the fix: 0.947 s manual and 0.944 s scheduled.
- Memory OOM passed for both triggers only with the validation service's runtime `MemorySwapMax=0`. With swap allowed, the sample survived; RAM limits alone do not prohibit swap. Restoration of the temporary swap setting still needs confirmation.
- Forced-stop recovery passed: manual operation `a3f5e13d-ee32-4880-871f-5cafd709e73a` became `interrupted` / `service_restart`; scheduled operation `09055b60-62da-45d8-b2ed-4dafabd6b3d9` became `unknown` / `agent_restart`. Recorded task PIDs and cgroups were absent. Resubmitting the scheduled ID retained its state and timestamps without a new cgroup.
- Limitation: `systemctl kill --kill-whom=all --signal=SIGKILL` returned auxiliary-process `EINVAL` in both forced-stop trials. The journal confirms main-process SIGKILL and recovery evidence above; the command itself did not complete cleanly and the cause remains unresolved.
- Concurrent submissions and post-completion replay of operation `725acf96-d52f-4e02-86d8-660581668238` returned the same ID/result; execution completed with exit 0 in 20391 ms, and no cgroup reappeared.
- Fingerprint conflict (409), incorrect HMAC key (401), arbitrary command payload (400), disabled task (409), unpublished task (409) and disabled environment (409) were rejected without creating an operation or execution cgroup.
- Invalid environment validation status was also rejected with 409 and no operation/cgroup: operation `bf181335-e562-4e42-9b58-9ac4012da823`. Restoration of the original interpreter and successful revalidation must be confirmed before further execution.
- Subsequent restore drill (2026-11-17): operator confirmed recovery of the original legacy task name and an empty installed crontab. Read-only checks passed SQLite integrity and foreign keys; all nine restored tasks were disabled and required publication review. The original `drill-cancel` ID and owner were retained. The restored `validation-python312` environment was enabled/valid with `/usr/bin/python3.12` and the expected fixture working directory.
- Final validation-account review: UID 994/GID 987, no supplementary groups; only the fixture root and `/usr/bin/python3.12` were allowed, with no trusted-owner/group-write exceptions configured. Data directory/database modes were 0700/0600; root-owned fixture directory, script and C wrapper were 0755/0644/0755. `KillMode=control-group`, delegation enabled and `MemorySwapMax=infinity` confirmed restoration of the temporary swap setting.
- Ubuntu automated user regression run (2026-11-17): 19 passed, 320 skipped, using temporary SQLite databases. Covered user store/API, legacy migration, predeploy admin validation, sessions and user backup recovery. The injected locked-session-store diagnostic was expected. This is not a manual SQLite-provider deployment, recovery-CLI or browser drill; the validation service remained on `AUTH_PROVIDER=env`.
- Full Ubuntu regression run (2026-11-17): all 384 tests across seven files passed in 34.31 s with `SHELL=/bin/sh` set only for the test process. The initial run had 19 failures with the service account's inherited `SHELL=/usr/sbin/nologin`; the legacy executor honours `SHELL`. No account login shell or service configuration was changed. Expected import, session-lock and alert failure-injection diagnostics were emitted. Coverage and remote CI were not part of this run.
- Ubuntu coverage rerun on `b07de19f50be476b6bfbb84332907d1e57062d1c`: 384/384 tests passed in 35.43 s. Global coverage passed the configured thresholds: 76.57% lines/statements, 73.53% branches and 80.39% functions. Reports were redirected to a private temporary directory after the protected checkout correctly rejected creation of `coverage`. The operator also supplied a silent ESLint run and a production dependency audit reporting zero vulnerabilities.
- Remote CI for the same commit passed: [run 43993995168](https://github.com/Kowts/crontab-ui/actions/runs/43993995168). Node 20/22 test jobs, dependency audits, container scans and Docker scheduler integration passed, including recovery, recreation/read-only-root resilience and split deployment. This does not demonstrate a manual rollback to the previous production image or approve a later release commit.
- Operator-run Docker recovery test (2026-11-17): local image `sha256:b0bf1e8af4d14c8aea52f91a09474bc4040784cb62c41b77d2e4d70638ba1225` from the validation checkout restored a synthetic backup into a clean volume and started healthy. The previous v0.6.3 image `ghcr.io/kowts/crontab-ui@sha256:5735d315917a3cebab49faa4c64b5a658c61d0f0334315082d5076ae60c44695` read a synthetic legacy task from the new image's data volume and started healthy. This test does not establish rollback compatibility for structured tasks, SQLite users, representative production data or the actual production deployment.
- Isolated SQLite-provider deployment drill (2026-11-17): a separate Docker volume and loopback port 8511 were used with synthetic credentials. Environment-provider login passed, migration created a verified backup and imported four accounts, and the SQLite-provider container started healthy. The operator reported successful login/access checks for all four roles, session revocation on viewer deactivation and last-active-admin protection.
- SQLite CLI recovery created a verified backup; the operator confirmed old-session revocation, rejection of the old password, temporary-password login and password reset with a subsequent successful login. The temporary credential was exposed during evidence sharing and was reported replaced; it must not be reused.
- SQLite account restore was reported successful: the pre-marker backup restored the original four accounts, removed the subsequently created viewer and revoked the admin session, with login using the backed-up credential. The exact backup filename was not supplied. Provider rollback to retained environment credentials and the independent Ubuntu-agent drill remain pending.
- Subsequent provider rollback passed: the SQLite container was stopped, the retained environment-provider container started healthy, and the operator confirmed login with the original synthetic environment credentials and absence of SQLite user administration.
- Isolated Ubuntu-agent initial checks passed after the delegation fix: service UID 993, socket UID/GID 993/985 and mode 0660, empty delegated parent and enabled cpu/memory/pids controllers. A non-root client using only the dedicated socket group passed signed health, incorrect-key rejection (401), empty-policy rejection (409), rejected-operation absence (404) and an empty active list. No agent task execution was authorised by the empty policy. Actual agent execution, resource enforcement, cancellation, restart/unknown, replay and identity-boundary adversarial drills were not performed; the maintainer explicitly waived these operational checks for v0.7.0.
- Disconnect-after-send operation `37d32716-66d8-4205-a307-87b6e772e339` was reconciled by query only, without resubmission or replacement UUID; exit 0 in 20433 ms.
- Legacy command manual and scheduled executions passed with exit 0, history and expected output; durations 7 ms and 15 ms, effective timeout 30 s. Email was not tested. The operator subsequently confirmed an empty validation crontab.
- Local checks on the cleanup commit: lint, 382 tests, coverage thresholds, production dependency audit (zero vulnerabilities) and whitespace checks passed. Coverage: 75.64% lines/statements, 73.60% branches and 79.66% functions. An initial run encountered port collisions and a backup timeout; the direct sequential Vitest rerun passed. This does not substitute for CI on the release commit.
- Still required: production-like sanitised backup/restore and user/recovery contracts, final UID/GID and allowed-root review, remaining deployment/rollback gates above, release metadata and green CI. The optional Ubuntu agent has a separate gate; these Native results do not approve it.

#### Native Linux evidence reported on 2026-11-15

- Operator-reported systemd: 255 (255.4-1ubuntu8.18), unified cgroup v2. Ubuntu release was not provided.
- Manual non-destructive sample: Python `/usr/bin/python3.12`, UID `1001`, working directory `/opt/crontab-ui-native-smoke`, cgroup `/system.slice/crontab-ui.service/execution-629e3f28-dd20-48cc-8a82-2dbc72c91d13`.
- Manual sample using the shared venv: Python `/opt/etl-processes/main-env/venv/bin/python`, same UID and working directory, cgroup `/system.slice/crontab-ui.service/execution-eb001773-9f31-4bb2-beb6-bfc712731c91`.
- These supplied outputs demonstrate basic manual execution, not scheduler dispatch, enforcement of resource limits, timeout/cancellation or recovery. They do not approve production ETLs or the optional Ubuntu agent.

For every remaining scenario, record the tested commit, Ubuntu/systemd versions, trigger,
operation ID, effective timeout, cgroup path, configured limits and observed result. On an
independent non-production instance, require:

- Manual and scheduled samples each execute once with the expected interpreter, UID and working directory, under a distinct `execution-*` cgroup belonging to the delegated service.
- Repeated submission of the same operation ID never starts a second process; lost acknowledgements and restart are explicitly unknown/interrupted and are not automatically replayed.
- A long-running sample and its descendants stop on timeout and cancellation; verify the processes disappear and the cgroup is cleaned up.
- Samples exceeding memory/PID limits cannot escape their configured cgroups; record actual limit files and observed failure. Measure CPU use against the configured quota.
- Restart during a sample leaves no descendants and produces an explicit recoverable state, never false success.
- Existing legacy scheduled tasks still run correctly; restored tasks and users preserve their documented contracts.

### Drill record - v0.6.3

- Date: 2026-11-13
- Environment (independent server / volume): independent non-production server `cvtvmetl01`
- Image or version tested (tag and digest): v0.6.3, ghcr.io/kowts/crontab-ui@sha256:5735d315917a3cebab49faa4c64b5a658c61d0f0334315082d5076ae60c44695; rollback target v0.6.2
- Run by: Kowts
- Backup and integrity, external copy: pass
- Restore into a clean volume: pass
- Rollback to the previous image: pass
- Users, roles and permissions: pass
- Configuration and secrets (`predeploy`): pass
- Scheduled tasks recovered: pass
- Task executed by the scheduler: pass
- Logs, history and audit: pass
- Notes and limitations: reported by the operator as all pass; no screenshots or command output were attached. Host name and time confirmed on the server (`hostname`: cvtvmetl01; `date -u`: Fri Nov 13 17:55:48 UTC 2026).

