# Open Science SDK coverage

The public SDK targets programmable research operations. A resource may be discoverable even
when the current runtime, configuration, or caller cannot use it. Run availability checks in
the scope where the operation will execute.

| Operation                                 | Public surface                                                                          | Scope and authority                                                                                 | Verification                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Discover Task protocol features           | `getCapabilities`                                                                       | Connected runtime and caller                                                                        | SDK contract test including older runtime                        |
| Discover configuration options            | `listConfigurationOptions`                                                              | Settings and configured resources; readiness checks remain separate                                 | Task API and authenticated HTTP tests                            |
| Manage task defaults                      | `getProjectSessionDefaults`, `updateProjectSessionDefaults`                             | Project, checked with `expectedUpdatedAt`; sampled when Task creates a Session                      | Existing Task API tests                                          |
| Read and edit task settings               | `getSessionConfiguration`, `updateSessionConfiguration`                                 | Session, checked with `expectedRevision`                                                            | Existing Task API tests                                          |
| Change internal agent routing             | `getAgentRouting`, `updateAgentRouting`                                                 | Application settings                                                                                | Existing Task API tests                                          |
| Submit, resume, observe, and cancel tasks | `startRun`, `submitRun`, `getSubmission`, `getRun`, `waitForRun`, `cancelRun`, `events` | Run and Session; durable admission availability varies by caller                                    | Existing Task and SDK tests                                      |
| Plan First and versioned decisions        | `startRun` with `turnIntent`, `getSessionPlan`, `respondSessionPlan`                    | Task-authorized access to the Session Plan                                                          | Existing Task and SDK tests                                      |
| Start or rerun a Review                   | `startSessionReview`, `listSessionReviews`, `getSessionReview`, `rerunSessionReview`    | Project, Session, completed turn and conversation branch; correction is opt-in for explicit Review  | Reviewer owner, Task API and authenticated HTTP tests            |
| Read visible messages and activities      | `getSessionHistory`                                                                     | Project and Session, active conversation branch                                                     | History scope and cursor tests                                   |
| Stage input files for a turn              | `stageRunAttachment`, `startRun`/`submitRun` with `attachmentIds`                       | Local caller and existing Session; one-use staged handles                                           | Attachment admission and SDK contract tests                      |
| Read and download task outputs            | `listArtifacts`, `downloadArtifact`                                                     | Managed Session artifacts                                                                           | Existing artifact integration tests                              |
| Observe pending interactions              | `listPendingSessionInteractions`, `watchPendingSessionInteractions`                     | Exact Project and Session, with live and validated durable interaction metadata                     | Task projection, Task API, HTTP, SDK watcher and Desktop tests    |
| Resolve protected interactions            | Desktop and Web                                                                         | Current human caller; preserve the existing operation-specific scopes                               | External host proof is a later SDK milestone                     |
| Submit and manage Compute Jobs            | Internal agent workflow                                                                 | Configured Host and project/session; use existing approval rules                                    | Direct SDK job lifecycle is a later milestone                    |
| Manage research resources                 | Partial Project, Connector, Credential, Literature methods                              | Each resource's application owner                                                                   | Expand by operation and record evidence before claiming coverage |

Pending interaction snapshots include live permission, question and Compute approval metadata.
The same methods report durable MCP permission waits, agent questions and delegated questions when
their saved Session and Branch still support a response.

First-release acceptance uses Desktop and standalone artifacts at the same revision on Windows
x64, macOS ARM64 and x64, and Linux ARM64 and x64. Real Slurm acceptance is a separate run
against an isolated profile, test partition and scratch namespace. Record the tested revision,
runtime, platform and backend with the results.

Local Windows x64 verification covers capability and settings discovery against both source-built
runtimes. The Desktop SDK journey also verifies project defaults on an actual fixture-backed Run,
reconnection, history, attachment input, and assessment-only Review. A separate SDK journey
observes a live permission request and verifies Run cancellation.

The opt-in Windows x64 Slurm verification exercised the configured scheduler from an isolated
profile. Denial produced no job. A once-approved job completed with exit code 0, captured both
output streams, and yielded a harvested artifact downloaded through the SDK. A separate
once-approved job was cancelled and removed through the existing owners. The packaged release
matrix is tracked separately from these local results.

To run the opt-in Slurm acceptance after `npm run build:e2e`, set
`OPEN_SCIENCE_E2E_REAL_SLURM=1`, `COMPUTE_TEST_SSH_ALIAS`, and `COMPUTE_SLURM_SCRATCH_ROOT` for an
authorized native OpenSSH configuration and writable scratch directory. Set
`OPEN_SCIENCE_E2E_SLURM_PARTITION` when the scheduler requires a designated test partition. Then run
`npx playwright test e2e/certification/sdk-slurm.spec.ts --workers 1 --retries 0`. The test uses an
isolated app profile, a unique scratch child, and fixed lightweight jobs. It exercises denial and
one-time authorization through the first-party Desktop dialog, verifies the harvested result
through the SDK, and releases the jobs through Session deletion.
