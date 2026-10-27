# Host library (Node.js)

Runs `msentity-viewer-backend`, provides the optional RDKit features, and
connects both to the UI components; no VS Code dependency.

| Export | Purpose |
|---|---|
| `BackendProcess` | one backend process: `start()`, `send(request)`, `request(request)` (awaits the reply with the same `request_id`), `stop()`; events `message`, `log`, `error`, `exit` |
| `findBackendExecutable({roots, override})` | the backend in `bin/<platform>/` or `build/backend/` |
| `RdkitChemistry` | RDKit (WebAssembly) in a worker thread: `capabilities` (Promise), `call("smarts-match" \| "structure-counts" \| "render", params)`, `stop()` |
| `DatasetSession` | dataset viewer requests: resolves SMARTS filters, answers structure requests, adds `capabilities` |

RDKit is the optional dependency `@rdkit/rdkit` (`npm install` here). Without
it, `RdkitChemistry` reports every capability as false and the rest works.
`MSENTITY_SPECTRUM_VIEWER_DISABLE_RDKIT=1` switches it off.

See [../docs/embedding.md](../docs/embedding.md#4-the-backend-and-the-host-library).
