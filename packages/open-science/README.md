# @aipoch/open-science

[AIPOCH Open-Science](https://github.com/aipoch/open-science) is an open-source, local-first,
model-agnostic AI research workbench. Use scientific Agents, Python and R Notebooks, and
scientific data connectors to turn research questions into reports, tables and figures.

This package provides the **standalone CLI, local Web UI and Node.js SDK**. npm installs the
matching platform package with the backend and resources; the desktop app is not required.

## Install

Install [Node.js](https://nodejs.org/) **22.13.0 or later**, then run:

```bash
npm install --global @aipoch/open-science
open-science --help
```

Supported platforms are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64.
Linux musl (including Alpine) and Windows ARM64 are not supported by the published native packages.
Keep npm optional dependencies enabled: they contain the platform runtime. If startup reports a
missing native package, reinstall with `npm install --global @aipoch/open-science --include=optional`.

Linux also needs working credential storage and Notebook sandbox prerequisites; see the
[Linux setup requirements](https://github.com/aipoch/open-science/blob/main/docs/standalone-runtime.md#linux-prerequisites).
Python/R and an Agent runtime/model provider are configured separately during setup.
For installations that include Node itself, see the
[Homebrew and Release archive options](https://github.com/aipoch/open-science/blob/main/docs/standalone-runtime.md).

## Get started

Start the local service and request its browser URL:

```bash
open-science start --no-open
open-science url
```

Open the printed URL, complete the setup checks, configure an Agent runtime and model provider,
and create your first research project. Set up a Python or R Notebook runtime if your work needs
code execution. The URL contains a local authentication token; keep it private.
For setup from the terminal, follow the
[CLI first-run guide](https://github.com/aipoch/open-science/blob/main/packages/open-science/CLI.md#first-run-setup-codex).

After setup, submit a task from the terminal:

```bash
open-science doctor --json
open-science project create "First research" --json
open-science run --project "First research" --prompt "Draft a research plan for comparing two analysis methods." --wait --jsonl
```

Confirm `ready: true` in the doctor output before submitting work. The CLI accepts a Project ID
or an exact, unambiguous name; SDK calls use IDs. Closing the browser does not stop the service:

```bash
open-science status --json
open-science stop
```

Stopping the service affects all connected clients. For automated tasks, review the
[permissions and output options](https://github.com/aipoch/open-science/blob/main/packages/open-science/CLI.md)
and the safety guidance below.

## Update or uninstall

Stop services started by this installation before replacing it. Use the same `--config-root`
when stopping and restarting a custom profile.

```bash
open-science stop
npm install --global @aipoch/open-science@latest
open-science start --no-open
```

To uninstall, stop the service and run `npm uninstall --global @aipoch/open-science`.
Uninstalling the npm package retains research data and credentials. Review
[release compatibility](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md)
before changing versions; replacing program files does not reverse data migrations.

## Documentation

- [CLI guide](https://github.com/aipoch/open-science/blob/main/packages/open-science/CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes
- [Product overview](https://github.com/aipoch/open-science#readme) - research workflows, screenshots and desktop downloads
- [Report an issue](https://github.com/aipoch/open-science/issues) - bugs and feature requests
- [Release compatibility](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md) - stable interfaces, versioning, and data upgrades
- [Intended use](https://github.com/aipoch/open-science/blob/main/docs/usage-scope.md) and [known limitations](https://github.com/aipoch/open-science/blob/main/docs/known-limitations.md) - workflow precautions, data disclosure, and execution boundaries

## Safety and integration

- **Scope:** Authenticated control of a local Open-Science service; the client does not provide an
  independent execution sandbox or isolate the service's Agents and tools.
- **Controls:** Requests use the service's permission profiles, existing grants, and host-owned
  runtime controls. Disabling interactive permission prompts denies requests needing a human; it
  does not erase previously granted authority.
- **Remaining risks:** A successful automated run can modify allowed files, contact configured
  services, or start remote jobs. A timeout or aborted wait stops observation, not the underlying run.
  Research outputs still need scientific review.
- **Safe integration:** Protect local service credentials, review the effective profile/grants and
  recipients, and use isolated test data before unattended operation. Cancel explicitly and confirm
  the resulting task/job state. Inspect downloaded or exported artifacts before sharing.

## Browser-held package import

Use `@aipoch/open-science/browser-import` to send a downloaded `.science` Blob to the desktop app.
See the [browser integration guide](https://github.com/aipoch/open-science/blob/main/packages/open-science/BROWSER_IMPORT.md) for the click flow, API, security contract,
limits, and browser requirements. The desktop never downloads the online package URL.

## SDK quick start

Install the package in your Node.js project (a global CLI install does not make it importable):

```bash
npm install @aipoch/open-science
```

Call `client.getCapabilities()` to get the connected application's version, platform, and
advertised Task capability IDs. Use the IDs to select optional operations, for example
`taskCapabilities.includes('durable-submissions')`. Older runtimes may return an empty list.
An advertised feature still depends on the operation's permissions and runtime requirements.

Start and configure the local service as above. Save the example in an `.mjs` file and run it
with Node.js. It creates a Project and uses its ID for subsequent requests:

```js
import { connectToOpenScience } from '@aipoch/open-science'

const client = await connectToOpenScience()
const project = await client.createProject({ name: 'Evidence review' })
const run = await client.startRun({
  project: project.id,
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto',
  permissionPrompts: 'none' // Deny requests that would require a human; keep existing permission rules.
})
const result = await client.waitForRun(run.id)
console.log(result.output)
```

Session, Project-default, and global Agent-routing configuration use the same authenticated local
API:

```js
const configuration = await client.getSessionConfiguration(run.sessionId)
await client.updateSessionConfiguration(run.sessionId, {
  expectedRevision: configuration.revision,
  memoryEnabled: false
})

const defaults = await client.getProjectSessionDefaults(project.id)
await client.updateProjectSessionDefaults(project.id, {
  expectedUpdatedAt: defaults.updatedAt,
  patch: { permissionProfile: 'auto' }
})

await client.updateAgentRouting({
  framework: 'codex',
  reviewer: { mode: 'inherit' },
  subagent: { mode: 'inherit' }
})

const runtimes = await client.listRuntimes()
```

Use `listPendingSessionInteractions(projectId, sessionId)` to see which live interactions need a
user decision. The `session-pending-interactions` capability covers permission requests,
provider or application structured questions in the current runtime, and Compute approvals
for that exact Project and Session. The method returns opaque IDs for polling, kind and safe
metadata, such as a question's field count or the Compute operation. Requests disappear from
the list when the owner settles them. An older server returns `unsupported_capability`.
Complete the interaction in Desktop or Web. Plan First still uses the Plan API.

This list reflects live application owners. Detached waits after a restart and delegated
structured questions stored only in the Session are outside the current projection. Review
the Session in Desktop or Web for those interactions.

When the server advertises `session-history`, read a Session's visible conversation with
`getSessionHistory(projectId, sessionId, { limit: 80 })`. The first page starts at the newest end;
pass its `beforeCursor` for earlier pages. Each page lists messages and activity summaries in
chronological order. Deduplicate by ID when assembling pages, as a page can include an earlier
prompt for context. If the server reports `session_history_cursor_stale`, reload the newest page.

The `session-run-attachments` capability adds files to a new turn in an existing Session. Get its
ID from `listSessions(project.id)` or from `startRun` after creating a Session without attachments.
The local SDK stages up to 8 MiB per file. A handle is bound to the Project and Session, expires
after 30 minutes or a service restart, and is consumed by a single admission attempt. Retrying the
same durable submission request ID returns its existing receipt. For a new attempt after the
handle was consumed, stage the file again.

```js
import { readFile } from 'node:fs/promises'

const input = await client.stageRunAttachment(project.id, run.sessionId, {
  name: 'observations.csv',
  mimeType: 'text/csv',
  bytes: await readFile('observations.csv')
})
const followUp = await client.startRun({
  project: project.id,
  sessionId: run.sessionId,
  prompt: 'Summarize the observations in this file.',
  attachmentIds: [input.id]
})
console.log(await client.waitForRun(followUp.id))
```

When the server advertises `configuration-options`, use `client.listConfigurationOptions()` to
discover selectable models, installed Skills, runnable Specialists, and configured Compute Hosts.
Use the returned `providerId`, `model`, Skill `id`, Specialist `id`, and Compute Host `providerId`
in Session, Project-default, or run options where applicable. A model entry without `model` uses the
provider's own default. Selectability reflects the active framework and configured catalog. It does
not check live provider credentials or Compute connectivity. The call reports
`configuration_options_unavailable` when the catalog is unavailable on the connected server.

On an attached Session, `configuration.runtimePermission` shows the current enforcement profile,
strategy, and full-access availability. `configuration.persisted.permissionProfile` is the saved
choice and `configuration.effective.permissionProfile` is the configuration selected for execution.
They can differ from the live runtime state. Without an attached runtime, `runtimePermission` is
omitted.

Session updates use `revision`; Project-default updates use `updatedAt`. Both reject stale writes.
Project defaults are copied only when a Session is created, with precedence `startRun` request,
Project defaults, application settings, then provider default. Agent-routing updates are atomic and
never return provider credentials.

Agent runtime listings expose only framework, readiness, version, and managed/external source. They
do not expose executable paths.

SDK requests have a 30-second default deadline that remains active while the response body is being
consumed. Override the client default with `requestTimeoutMs`, or pass `{ signal, timeoutMs }` as the
final options argument to an individual request method. `downloadArtifact` applies the deadline
to the response headers, then as an idle limit while its returned `Response` body is streaming:
each received chunk restarts the timer, so large downloads can take longer than the deadline but a
stalled body still fails with `timeout`. `waitForRun` applies its overall `timeoutMs` and
caller signal to every in-flight polling request as well as the delay between polls. Each poll is
bounded by the smaller of the client's `requestTimeoutMs` and the remaining total wait budget.
A request timeout fails the wait immediately; it does not silently retry. Without a total
`timeoutMs`, waiting has no overall deadline. `pollIntervalMs` defaults to 250 and must be a finite
positive number.

Aborting or timing out a wait stops only the local observation. The Run may continue on the host;
call `getRun(run.id)` to check it, or explicitly call `cancelRun(run.id)` to stop it. With
`returnOnAttention: true`, a returned Run may still have `status: 'running'` and need a Plan decision before it can finish. Ordinary permissions do not populate Run attention.

```js
const waitController = new AbortController()
const result = await client.waitForRun(run.id, {
  timeoutMs: 120_000, // Total wait budget; each poll still has the client request deadline.
  pollIntervalMs: 500,
  returnOnAttention: true,
  signal: waitController.signal // Aborts observation; does not call cancelRun.
})
console.log(result.status, result.attention)
```

For retry-safe project creation and Run starts, pass the same `idempotencyKey` in the final options
argument on every attempt. The daemon replays the first response for up to 24 hours while it remains
running; reusing a key with a different request body fails with `idempotency_conflict`. If the
bounded replay registry is full, a new unique key fails with `idempotency_unavailable` rather than
evicting an existing guarantee. A lost response after submission does not prove that the Run was
not started. Retry with the original key and identical request while that daemon is still running,
or query the known Run ID. The replay registry is process-local: a daemon restart loses it, so
reusing a key after restart is not a durable exactly-once guarantee.

The `project` request field and the `listSessions(projectId)` argument both require a Project ID.
Project display names are not accepted as routing identifiers.

SDK and HTTP callers must supply an absolute `cwd`. Open-Science canonicalizes and validates it,
persists it as the Session working directory, and returns the effective path on every Run. Supplying
`cwd` with `sessionId` is allowed only when both paths resolve to the same directory. Omit `cwd` to
use a managed workspace. External working directories remain caller-owned and are never removed by
Open-Science.

For live automation feedback, subscribe before starting the Run. `run.progress` reports ordered
provider-neutral phases and emits a progress heartbeat every ten seconds until the first visible
provider output. This progress heartbeat describes Run activity; it is separate from the filtered
connection heartbeat that keeps an otherwise-idle WebSocket alive. The timer starts after Task has
prepared the Session and registered its Run; Session creation or resume time before registration is
outside this event stream:

```js
const abortController = new AbortController()
const events = client.events({ signal: abortController.signal })
await events.ready

const progress = (async () => {
  for await (const event of events) {
    if (event.type === 'run.progress') {
      console.log(event.data.phase, event.data.elapsedMs, event.data.heartbeat)
    }
  }
})()

const observedRun = await client.startRun({
  project: project.id,
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto'
})
const observedResult = await client.waitForRun(observedRun.id)
abortController.abort()
await progress
console.log(observedResult.output)
```

`events.ready` rejects if the socket fails, closes, or receives no liveness frame before opening.
After opening, the iterator fails with `timeout` when no event or connection heartbeat arrives for
30 seconds. Pass `idleTimeoutMs` to change that connection-liveness window; it does not limit model,
Notebook, permission-approval, or other Run duration. Connection heartbeats are control frames and
are not yielded to consumers. Malformed frames and a consumer backlog above 1024 events terminate
the iterator with `event_stream_invalid_message` or `event_stream_overflow` instead of throwing
outside the iterator or growing memory without a bound.

Every Run event includes top-level `sequence`, `runId`, `sessionId`, and `projectId` fields in
addition to its existing `type` and `data`. After an established socket closes unexpectedly, the SDK
reconnects with its last sequence and the daemon replays the retained suffix. Replay is bounded and
process-local. If the daemon restarted or the suffix was evicted, the iterator yields
`stream.resync-required` with reason `stream-changed` or `cursor-expired`; read the Run or Session
through the HTTP API to restore authoritative state.

Plan First runs can opt into actionable waiting with returnOnAttention. When the returned Run has
attention.kind equal to plan-approval, use getSessionPlan and respondSessionPlan. Calling waitForRun
without returnOnAttention keeps the original terminal-only behavior.

Automatic review and Specialist binding reuse existing Session JSON fields. Delegation adds
delegationPolicy with values allow or deny; an omitted historical value restores as allow.

When the server advertises `session-reviews`, request an explicit assessment of the final Agent
message in a completed turn:

```js
const review = await client.startSessionReview(
  sessionId,
  {
    projectId,
    turnMessageId: finalAgentMessageId,
    messageBranchId
  },
  { idempotencyKey: 'review-request-1' }
)
if (review.started) {
  const report = await client.getSessionReview(sessionId, review.reviewId, { projectId })
  console.log(report.lifecycle, report.checks)
}
```

`listSessionReviews` filters by grouping turn and branch. `rerunSessionReview` takes an existing
Review ID and keeps its original grouping turn, audited turn, and branch. A new explicit review
and a rerun default to assessment only. Pass `allowCorrections: true` to allow the existing
Reviewer fix loop on the active root branch. Starting a review returns as soon as the Review row
is admitted. Read by its ID until its lifecycle reaches `complete` or `error`. `already-in-flight`
means another review already owns the turn. An idempotency key deduplicates exact retries within a
running server. Read the existing reports before retrying across a server restart.

To stop a still-running task instead of waiting for it, cancel it explicitly. Cancellation waits for
provider work and application finalization to drain before returning the terminal Run:

```js
const cancelled = await client.cancelRun(run.id)
console.log(cancelled.status) // cancelled
```

The client discovers the local daemon and reads its authentication token from the Open-Science config
directory. HTTP calls send the token in request headers. `events()` authenticates its WebSocket using
a `token` URL query parameter; treat WebSocket URLs and request logs as sensitive. Tokens are
not included in normal command output.

### Automation new-session defaults

`project session-defaults show|update` manages defaults for new Sessions created through the
Task CLI/API. Explicit run options override these defaults. Existing Sessions and desktop New
conversation drafts are not changed.

`--provider-default-model` keeps following the provider-owned default instead of pinning the
first model in its catalog. An explicit `--model` stays fixed. If a saved selection becomes
unavailable, choose a replacement explicitly or wait for it to become available again.
