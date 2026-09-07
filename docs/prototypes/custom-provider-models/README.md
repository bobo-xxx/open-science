# Custom Provider multi-model prototype

This is an English, standalone interaction prototype for discussing multi-model management in Open Science custom Providers. It is not production code. Its layout, controls, and detailed behavior are open to improvement or replacement.

## Open the prototype

Download [index.html](index.html) using GitHub's download button, then open the downloaded file in a browser. No installation or local server is required.

All requests and test results are simulated. Model names and capability values are fictional; the key is a read-only placeholder. Changes stay in page memory and reset on reload. The prototype never connects to an API or changes an Open Science installation.

## Explore

- Add multiple models under shared connection settings.
- Discover model IDs and selectively import them without replacing existing settings.
- Edit context size, token caps, vision support, and reasoning settings independently.
- Continue manually when discovery is unavailable.
- Change a default while preserving a simulated session's explicit model selection.
- Test one model, selected models, or all models; inspect separate results, retry selections, and stop a batch.

The scenario tabs reset the demo to known starting states. For model tests, the mixed-response fixture passes `analysis-pro`, denies access to `analysis-fast`, and times out `vision-lab`. Select “Every model responds” to simulate a successful retry.

## Screenshots

- [Provider with multiple models](01-provider-models.png)
- [Selective discovery](02-model-discovery.png)
- [Per-model capabilities](03-model-capabilities.png)
- [Discovery unavailable](04-discovery-unavailable.png)
- [Session-reference protection](05-session-protection.png)
- [Individual and batch testing](06-model-tests.png)

## What is intentionally illustrative

The Settings navigation is visual context. Model discovery, authentication, persistence, migrations, and session routing are not implemented. The reasoning-level menu is only a representative subset of the production catalog. A short text test is not a full capability test.

The accompanying proposal suggests compact rows, searchable discovery, explicit handling of unsaved test configuration, useful error details, and “Needs retest” labels. The initial prototype does not implement every refinement. Its strict removal blocking is one example, not a required architecture or history policy.

## Verification

A local isolated-browser walkthrough passed 24 checks covering the demo's model management, discovery, editing, defaults, removal protection, per-model and batch testing, cancellation, result invalidation, reset behavior, and narrow viewport. See [verification.json](verification.json). This verifies the prototype only, not Open Science's production behavior.
