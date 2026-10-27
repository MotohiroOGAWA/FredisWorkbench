# Using this repository in another project

msentity-spectrum-viewer is meant to be added to other projects as a Git
submodule. It then provides three things, which can be used separately:

| Part | Directory | Use it for |
|---|---|---|
| msentity, msentity-similarity | `external/` (nested submodules) | reading/writing spectra and similarity results from C++, C, Python, Java, C# |
| UI components | `ui/` | showing a dataset table, a spectrum, or a similarity result in any web page or webview |
| Backend and host library | `backend/`, `host/` | serving those components from data files (Node.js host) |

```console
git submodule add <url>/msentity-spectrum-viewer.git third_party/msentity-spectrum-viewer
git submodule update --init --recursive        # also fetches external/msentity*
```

The versions of msentity and msentity-similarity are those recorded in this
repository's submodules, so a project that includes the viewer uses exactly the
libraries the viewer was tested with.

## 1. msentity and msentity-similarity from C++

```cmake
# CMakeLists.txt of your project
set(MSENTITY_VIEWER_BUILD_BACKEND OFF)        # optional: skip the viewer backend
add_subdirectory(third_party/msentity-spectrum-viewer)

target_link_libraries(app PRIVATE msentity::msentity msentity::similarity)
```

```cpp
#include <msentity/msentity.hpp>
#include <msentity/similarity/similarity.hpp>

auto ds = msentity::io::load_ms_dataset("example.msp");          // 2 spectra
auto matrix = msentity::similarity::all_pairs_matrix(ds, ds);    // matrix[1] = 0.759714
```

`add_subdirectory` builds msentity-similarity, which uses `external/msentity`
(the viewer sets `FETCHCONTENT_SOURCE_DIR_MSENTITY` to it), so only one copy of
msentity is compiled. The C APIs used by the language bindings are off by
default; turn them on before `add_subdirectory` when you need them:

```cmake
set(MSENTITY_BUILD_C_API ON CACHE BOOL "" FORCE)             # libmsentity_c
set(MSENTITY_SIMILARITY_BUILD_C_API ON CACHE BOOL "" FORCE)  # libmsentity_similarity_c
```

## 2. msentity from Python, Java, or C#

The bindings live in the nested submodules:

| Language | msentity | msentity-similarity |
|---|---|---|
| Python | `external/msentity/bindings/python` | `external/msentity-similarity/bindings/python` |
| Java | `external/msentity/bindings/java` | `external/msentity-similarity/bindings/java` |
| C# | `external/msentity/bindings/csharp` | `external/msentity-similarity/bindings/csharp` |

Each needs the C library built as above (or the release packages of msentity);
see `external/msentity/docs/bindings.md` and
`external/msentity-similarity/docs/bindings.md`.

## 3. The UI components

Each component is one script and one stylesheet with no dependencies. It
renders into a fixed element and talks to its host only through messages, so
any part can be used on its own:

| Component | Files | Element | Shows |
|---|---|---|---|
| Dataset table | `ui/viewer.js`, `ui/viewer.css` | `<div id="app" data-filename="…">` | paged metadata table, filters, editing, dataset list |
| Spectrum | `ui/spectrum.js`, `ui/spectrum.css` | `<div id="spectrum-app">` | one spectrum or a mirrored comparison, peak table, image export |
| Similarity result | `ui/similarity.js`, `ui/similarity.css` | `<div id="app" data-filename="…">` | result table, histogram/box plot, statistics |

Messages to a component are `message` events on `window`; messages from it go
to `acquireVsCodeApi().postMessage` inside a VS Code webview and to
`window.msentityViewerHost.postMessage` anywhere else. The messages are listed
in [protocol.md](protocol.md).

Example: the spectrum component in a plain page, without any backend:

```html
<link rel="stylesheet" href="ui/spectrum.css">
<div id="spectrum-app"></div>
<script>
  // Messages from the component (image export, peak copy, ...).
  window.msentityViewerHost = { postMessage: (message) => console.log(message) };
</script>
<script src="ui/spectrum.js"></script>
<script>
  window.postMessage({
    type: "spectrum",
    payload: {
      title: "MassSpecID0000001", datasetName: "example.msp", globalIndex: 0,
      columns: ["Name"], row: { Name: "MassSpecID0000001" },
      spectrum: { mz: [91.0542, 125.0233, 185.0961, 246.1125],
                  intensity: [0.245, 1.0, 0.349, 0.735],
                  metadata_columns: [], metadata: [] }
    }
  }, "*");
</script>
```

The components use VS Code's theme variables (`--vscode-editor-background`,
`--vscode-foreground`, …); define them in the page to style the components
outside VS Code.

## 4. The backend and the host library

To show data files, run the backend and connect it to a component. The
Node.js host library does this without VS Code:

```js
const { BackendProcess, RdkitChemistry, DatasetSession, findBackendExecutable } =
  require("./third_party/msentity-spectrum-viewer/host");

const backend = new BackendProcess({
  executable: findBackendExecutable({ roots: ["third_party/msentity-spectrum-viewer"] }),
  mode: "dataset", file: "/data/example.msp", pageSize: 20,
});
const chemistry = new RdkitChemistry();            // optional: SMARTS, structures (needs @rdkit/rdkit)
const session = new DatasetSession(backend, chemistry, (message) => {
  webview.postMessage(message);                     // to ui/viewer.js
});
backend.start();
webview.onMessage((message) => {                    // from ui/viewer.js
  if (message.type === "page-request") {
    session.request({ type: "page", page: message.page, dataset_id: message.datasetId,
                      filters: message.filters, sort: message.sort });
  }
  // ... the other messages: see protocol.md
});
```

`DatasetSession` handles the chemistry part of the protocol: it turns SMARTS
filters into row-id filters with RDKit and answers structure requests. Pass
`null` instead of `chemistry` to leave these features off; RDKit is the
optional dependency `@rdkit/rdkit` of `host/` (`cd host && npm install`).

Messages from the UI need a small translation before they reach the session
(`page-request` → `page`, `datasetId` → `dataset_id`, and dialogs for export,
SpecID, and similarity); [protocol.md](protocol.md#host-messages-from-the-ui)
lists every message, and [`vscode/extension.js`](../vscode/extension.js) is a
complete host.

`findBackendExecutable` finds `build/backend/msentity-viewer-backend` after
building this repository with CMake (section 1 with
`MSENTITY_VIEWER_BUILD_BACKEND` left ON), or an executable given by the
`MSENTITY_VIEWER_BACKEND` environment variable.
