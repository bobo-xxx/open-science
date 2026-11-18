# Open Science SDK coverage

The public SDK targets programmable research operations. A resource may be discoverable even
when the current runtime, configuration, or caller cannot use it. Run availability checks in
the scope where the operation will execute.

| Operation                                 | Public surface                                                                          | Scope and authority                                                                                | Verification                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Discover Task protocol features           | `getCapabilities`                                                                       | Connected runtime and caller                                                                       | SDK contract test including older runtime                        |
| Discover configuration options            | `listConfigurationOptions`                                                              | Settings and configured resources; readiness checks remain separate                                | Task API and authenticated HTTP tests                            |
| Manage task defaults                      | `getProjectSessionDefaults`, `updateProjectSessionDefaults`                             | Project, checked with `expectedUpdatedAt`; sampled when Task creates a Session                     | Existing Task API tests                                          |
| Read and edit task settings               | `getSessionConfiguration`, `updateSessionConfiguration`                                 | Session, checked with `expectedRevision`                                                           | Existing Task API tests                                          |
| Change internal agent routing             | `getAgentRouting`, `updateAgentRouting`                                                 | Application settings                                                                               | Existing Task API tests                                          |
| Submit, resume, observe, and cancel tasks | `startRun`, `submitRun`, `getSubmission`, `getRun`, `waitForRun`, `cancelRun`, `events` | Run and Session; durable admission availability varies by caller                                   | Existing Task and SDK tests                                      |
| Plan First and versioned decisions        | `startRun` with `turnIntent`, `getSessionPlan`, `respondSessionPlan`                    | Task-authorized access to the Session Plan                                                         | Existing Task and SDK tests                                      |
| Start or rerun a Review                   | `startSessionReview`, `listSessionReviews`, `getSessionReview`, `rerunSessionReview`    | Project, Session, completed turn and conversation branch; correction is opt-in for explicit Review | Reviewer owner, Task API and authenticated HTTP tests            |
| Read visible messages and activities      | `getSessionHistory`                                                                     | Project and Session, active conversation branch                                                    | History scope and cursor tests                                   |
| Stage input files for a turn              | `stageRunAttachment`, `startRun`/`submitRun` with `attachmentIds`                       | Local caller and existing Session; one-use staged handles                                          | Attachment admission and SDK contract tests                      |
| Read and download task outputs            | `listArtifacts`, `downloadArtifact`                                                     | Managed Session artifacts                                                                          | Existing artifact integration tests                              |
| Resolve protected interactions            | Desktop and Web                                                                         | Current human caller; preserve the existing operation-specific scopes                              | External host proof is a later SDK milestone                     |
| Submit and manage Compute Jobs            | Internal agent workflow                                                                 | Configured Host and project/session; use existing approval rules                                   | Direct SDK job lifecycle is a later milestone                    |
| Manage research resources                 | Partial Project, Connector, Credential, Literature methods                              | Each resource's application owner                                                                  | Expand by operation and record evidence before claiming coverage |

First-release acceptance uses Desktop and standalone artifacts at the same revision on Windows
x64, macOS ARM64 and x64, and Linux ARM64 and x64. Real Slurm acceptance is a separate run
against an isolated profile, test partition and scratch namespace. Record the tested revision,
runtime, platform and backend with the results.

Local Windows x64 verification covers capability and settings discovery against both source-built
runtimes. The Desktop SDK journey also verifies project defaults on an actual fixture-backed Run,
reconnection, history, and attachment input. This local evidence does not cover the packaged
release matrix.
