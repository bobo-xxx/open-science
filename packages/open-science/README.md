# @aipoch/open-science

Node.js SDK and command-line client for an Open Science daemon running on the local machine.

## Documentation

- [CLI guide](./CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes

## SDK quick start

```js
import { connectToOpenScience } from '@aipoch/open-science'

const client = await connectToOpenScience()
const run = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  workspacePath: '/absolute/path/to/task-workspace',
  permissionProfile: 'auto'
})
const result = await client.waitForRun(run.id)
console.log(result.workspacePath, result.output)
```

`workspacePath` must name an existing absolute directory. It becomes the ACP working directory for
the new session and cannot be changed when that session is resumed. Each returned run includes the
effective workspace reported by ACP.

Use `await client.getConfiguration()` to capture the active non-secret reproducibility snapshot,
including the Open Science version, agent/provider/model selection, reasoning effort, and the exact
enabled skill and connector IDs. Authentication material and local configuration paths are omitted.

The client discovers the local daemon and reads its authentication token from the Open Science config
directory. Tokens are sent in request headers and are never included in normal command output.
