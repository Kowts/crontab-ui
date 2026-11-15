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

- Status: **not approved for production**
- Required before release: an independent Ubuntu VM drill covering the rows above, with environment, image digest, date, operator and outputs recorded.
- The Windows development session validates JavaScript, API, SQLite, HMAC and policy logic only; it does not prove Linux UDS permissions, C wrapper compilation, systemd delegation or cgroup behaviour.

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

