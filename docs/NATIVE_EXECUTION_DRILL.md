# Native Linux release drill

This procedure produces evidence, not a production approval by itself. Run it on an
**independent, non-production Ubuntu instance**, with a dedicated service account, private
database and its own user crontab. Do not reuse production accounts, configuration, ETLs,
credentials, databases or the central ETL venv for resource-exhaustion probes.

The fixture refuses root, direct shell execution, the production service cgroup and
unexpected resource limits. All allocations, child counts and runtimes are bounded.
Do not weaken its guards to make a failing test pass.

The fixture uses Python's standard library only. Validate its refusal/measurement
logic without running resource probes:

```bash
python3.12 -m unittest discover -s tests -p native_execution_probe.py
npm test -- tests/native-dispatch.js
```

These mock-based guard tests do not validate the Linux kernel.

## 1. Prepare the independent instance

Use the normal installation procedure with these test-only choices:

- Unit: `crontab-ui-validation.service`.
- A dedicated, non-root Unix account; no access to production ETLs or secrets.
- An empty private database directory, for example `/var/lib/crontab-ui-validation`,
  owned by that account with mode `0700`.
- A separate loopback port, for example `8510`, confirmed unused before starting.
- Authenticated UI and CSRF enabled; credentials provisioned separately.
- The reviewed C wrapper, root-owned, mode `0755`, without setuid or capabilities.
- The native cgroup [systemd drop-in](../deploy/systemd/crontab-ui-native-cgroup.conf.example),
  installed for the **validation** unit, including `KillMode=control-group`.
- `Restart=no` during the forced-stop drill, so the operator controls recovery.

Do not copy a production environment file. In the validation service's environment set:

```dotenv
CRON_DB_PATH=/var/lib/crontab-ui-validation
HOST=127.0.0.1
PORT=8510
ENABLE_NATIVE_DISPATCH=true
STRUCTURED_EXECUTION_ROOTS=/opt/crontab-ui-validation-fixtures
STRUCTURED_EXECUTION_EXECUTABLES=/usr/bin/python3.12
STRUCTURED_EXECUTION_CGROUP_WRAPPER=/usr/local/libexec/crontab-ui-agent-exec
STRUCTURED_EXECUTION_MEMORY_MAX_BYTES=67108864
STRUCTURED_EXECUTION_CPU_QUOTA_PERCENT=25
STRUCTURED_EXECUTION_PIDS_MAX=8
COMMAND_KILL_GRACE_MS=1000
```

Keep the required authentication, RBAC, CSRF and transport configuration from the normal
installation procedure. `ALLOW_HTTP=true` is acceptable only on the isolated, approved test
network; HTTPS remains the production default. Leave `CRON_IN_DOCKER` unset.

Do not configure trusted UIDs/GIDs or group-writable roots for these root-owned fixtures.
Verify the runtime path using `readlink -f /usr/bin/python3.12`; the executable allowlist
must use its actual canonical path.

From the reviewed application checkout, install just the fixture:

```bash
sudo install -d -o root -g root -m 0755 /opt/crontab-ui-validation-fixtures
sudo install -o root -g root -m 0644 scripts/native-execution-probe.py \
  /opt/crontab-ui-validation-fixtures/probe.py
```

Provision the dispatch key once **as the validation service account**, from the checkout:

```bash
node -e "require('./lib/native-dispatch').initializeKey('/var/lib/crontab-ui-validation')"
```

This command refuses to overwrite a key. Never print the key or place it in scripts,
cron lines, evidence or version control. Start the validation service only after reviewing
its account, directories, port and environment. A native startup failure must not be
bypassed by running the runner directly.

Capture the following read-only evidence:

```bash
git rev-parse HEAD
node --version
python3.12 --version
cat /etc/os-release
systemd --version
systemctl show crontab-ui-validation.service \
  -p User -p Group -p MainPID -p ControlGroup -p Delegate \
  -p DelegateSubgroup -p KillMode -p Restart
curl --fail --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --connect-timeout 2 --max-time 5 http://127.0.0.1:8510/healthz
```

Verify that `MainPID` belongs to the validation unit's `crontab-ui-supervisor` subgroup.
With that account, check the database directory, key and socket ownership/modes using
`stat` without displaying their contents.

## 2. Create the probe tasks

In the validation UI, create a Native Linux Python environment with executable
`/usr/bin/python3.12` and default working directory
`/opt/crontab-ui-validation-fixtures`. Save, validate and confirm `valid`.

Create structured tasks with script `/opt/crontab-ui-validation-fixtures/probe.py`,
that same working directory and **one individual argument** from the table below.
Use the listed timeout in milliseconds. Do not give these probes an unlimited timeout.
Keep only one probe active at a time.

| Argument | Timeout | Expected evidence |
| --- | ---: | --- |
| `baseline` | 15000 | Exit 0; one `ready` record with expected UID/interpreter/cwd and validation-unit execution cgroup |
| `wait` | 5000 | Timeout; no process or execution cgroup left after the grace period |
| `descendants` | 5000 | Parent and detached child ignore TERM; both disappear after escalation |
| `parent-exit` | 15000 | Parent exits 0; detached child is killed by cleanup, not left alive for its 20-second sleep |
| `cpu` | 15000 | Ten-second busy sample; CPU seconds no greater than `elapsed * 0.25 * 1.25 + 0.25` |
| `memory` | 15000 | Bounded 96 MiB allocation meets the 64 MiB limit; OOM kill, not success |
| `pids` | 15000 | Bounded spawn refused with EAGAIN and an increment in `pids.events:max`; probe exits 0 after cleaning its children |

The 25% CPU ceiling includes a 25% tolerance and a 0.25-second burst allowance.
Do not fail a CPU test merely because wall time increases on a busy host.
Memory swap policy can change OOM behaviour: if the allocation survives, record
`memory.swap.max`, `memory.current` and `memory.events`. That outcome is **not** evidence
of an OOM kill and must be investigated, not marked passed.

For each task, first run manually and collect its execution-panel output, terminal state,
effective timeout and operation ID. Repeat through **real user cron**:

1. Enable only that probe with a one-minute schedule and publish from the validation UI.
2. Inspect **Installed crontab**; confirm the runner uses the validation database path.
3. Wait for a `scheduled` execution. The runner's cron cgroup is irrelevant: the probe's
   `ready` output must name the validation service's own `execution-<operation ID>` cgroup.
4. Pause the probe and **republish** before the next minute. Pausing locally alone does
   not prove the installed schedule was removed. Check Installed crontab again.
5. Reconcile every actual cron occurrence with history and the dispatch journal.
   Different scheduled minutes legitimately have different IDs.

Keep cron stderr observable in this test account. If no history appears, inspect that
output and the validation service journal; do not assume it ran and do not retry an
unknown operation automatically.

## 3. Cancellation, cleanup and restart

### Capture and verify cleanup

Use `ready` / `child_started` records to capture the cgroup path and the parent's and
child's PIDs while they are alive. Inspect **only** that exact execution directory:

```bash
# Replace the UUID with the ID from this validation execution, not a service-wide path.
CG='/sys/fs/cgroup/system.slice/crontab-ui-validation.service/execution-replace-with-UUID'
cat "$CG/cgroup.procs" "$CG/memory.max" "$CG/cpu.max" "$CG/pids.max"
cat "$CG/memory.events" "$CG/pids.events" "$CG/cpu.stat"
```

The directory may disappear quickly on completion; collect limit files while the
sample is alive. Missing evidence is `not tested`, not a pass.

After timeout/cancellation/parent exit, require that the exact execution directory is
absent within **5 seconds after terminal state** and the recorded processes are gone.
Use `/proc/<PID>/stat` start-time field to distinguish the original process from PID
reuse; do not kill a PID merely because its number was recorded earlier. Never use
name-based kills, service-wide `cgroup.kill`, or a broad directory removal.

If a directory remains or a recorded child survives, retain the evidence and fail the
cleanup gate. Do not hide the failure with a manual deletion. Cleanup code is currently
best effort; unit-test success does not prove kernel removal has finished.

### Manual and scheduled cancellation

Use `wait` with timeout `30000`. For the manual run, click its execution-cancellation
button while it is active; require terminal `cancelled`, not success, and cleanup.

Scheduled cancellation uses the signed dispatcher, **not** `/runjob/cancel` (that
endpoint manages manual runs). As the validation account, from the checkout, use the
operation ID observed in the exact execution cgroup:

```bash
OPERATION_ID='replace-with-operation-UUID' node - <<'NODE'
const fs = require('fs');
const { LocalAgentClient } = require('./lib/agent-client');
const directory = '/var/lib/crontab-ui-validation';
const client = new LocalAgentClient({
  secret: fs.readFileSync(`${directory}/native-dispatch.key`),
  socketPath: `${directory}/native-dispatch.sock`,
});
client.request('/v1/cancel-execution', { operation_id: process.env.OPERATION_ID })
  .then(result => {
    console.log(JSON.stringify(result));
    if (!result.accepted) process.exitCode = 1;
  })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
```

An `accepted` cancellation is only a request acknowledgement. Require the actual
`cancelled` result and the same process/cgroup cleanup checks.

### Graceful and forced service stop

Run `wait` with timeout `30000`. Before either stop, pause/republish the schedule;
confirm Installed crontab no longer contains the probe while its current execution
remains active. Repeat separately for manual and scheduled runs.
If the bounded 20-second sample finishes before the stop, repeat the scenario; that
run does not demonstrate restart recovery.

- Graceful: `sudo systemctl stop crontab-ui-validation.service`. Verify no recorded
  descendants survive; start it again and inspect the outcome.
- Forced: only on this independent validation unit, use
  `sudo systemctl kill --kill-whom=all --signal=SIGKILL crontab-ui-validation.service`.
  Verify the recorded processes disappeared, then stop/start the unit to recover.

Do not use these commands against the production unit. Graceful scheduled executions
should finish as cancelled. After a forced stop, accepted scheduled operations must be
`unknown` in `native-dispatch.db`; manual operations must be interrupted on recovery.
There must be no automatic second start and no false `completed` record. A hard kill
may prevent the central history's final record: the durable dispatcher outcome is
required evidence, not a fabricated history result.

## 4. Idempotency, authentication and unknown outcomes

On the validation account, use `LocalAgentClient` with the same private key/socket as
above. Resolve the current job using `crontab.getJobForNativeDispatch(taskId)` and
its fingerprint using `scheduledFingerprint(job)` from `lib/native-dispatch`.

- Submit `{ operation_id, task_id, fingerprint }` twice with **the same UUID** using
  `/v1/submit-execution`. Do this concurrently while `wait` is active, and again after
  completion. Require one execution/start only and the same returned operation ID.
- Submit the same UUID with a different fingerprint: require HTTP 409 and no start.
- Use a random incorrect secret: require HTTP 401 and no start.
- Add `command`, script paths or arbitrary arguments to the payload: require HTTP 400
  and no start. Disable/unpublish the fixture or invalidate its environment:
  submission with a new ID must fail without starting a process.
- Disconnect after submitting a complete signed request but before reading the reply.
  Reconcile **only** by signed query `/v1/executions/<UUID>`; do not submit a replacement.
  If acceptance cannot be demonstrated, record that outcome as unknown.
- After the forced-stop scenario, query and resubmit its **original ID**. It must stay
  `unknown` and must not start a new process.

For read-only durable evidence, open `native-dispatch.db` using SQLite read-only mode
and select only `operation_id`, `task_id`, `status`, `exit_code`, `signal`,
`termination_reason` and `duration_ms` from `agent_executions`. Do not inspect user
passwords, session data or the secret key. Preserve this journal during recovery:
there is currently no automatic operation pruning; monitor its disk usage. Deleting
the journal loses idempotency evidence and is not a rollback procedure.

## 5. Compatibility and trust review

- In the independent instance, run a harmless legacy `command` task manually and from
  cron. Require the previous history/mail/output contracts; dispatcher opt-in must not
  reroute legacy commands.
- With a **sanitised** representative backup, verify import/restore, task identity,
  publication review, SQLite-user session revocation and last-admin protection.
  Do not export production password hashes or secret-bearing commands as test data.
- Review UID/GID membership and exact allowed roots separately from exhaustion tests.
  For a shared ETL venv, approve only the intended scripts and venv roots, not an
  entire unrelated `/opt` tree. Group writers can influence code with the service
  account's privileges; cgroups do not isolate file access or credentials.
- The optional Ubuntu agent remains a separate release gate. Native results do not
  approve its identity boundary, launcher or independent policy.

## 6. Evidence and cleanup

For **each trigger and scenario**, record:

```text
Commit / Ubuntu / systemd / Node / Python:
Independent unit and database:
Scenario / trigger / task ID / operation ID:
Expected UID / interpreter / cwd:
Cgroup / parent PID+start time / child PID+start time:
memory.max / memory.swap.max / cpu.max / pids.max:
Effective timeout / duration / terminal state / exit code / signal:
Observed counters or CPU measurement:
Processes absent / cgroup absent within 5 seconds:
Number of starts for the same operation ID:
Result: pass / fail / not tested
Limitations:
```

Attach sanitised evidence to the release issue/PR. No automatic gate has been passed
by adding this document or fixture. Any failed or untested mandatory scenario blocks
stable v0.7.0.

When finished, remove test tasks from the validation UI, publish their removal and
verify the test crontab. Stop the validation unit. Retain sanitised evidence and the
private journal for reconciliation. Remove only the installed `probe.py` and use
`rmdir` on its now-empty fixture directory. Never recursively delete an application,
data, ETL or cgroup tree; never remove the production venv or shared C wrapper.
