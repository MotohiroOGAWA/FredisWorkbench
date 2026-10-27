# Viewer protocol

The UI components ([`ui/`](../ui)), the host ([`host/`](../host), or any other
program), and the backend ([`backend/`](../backend)) exchange JSON messages.
The same messages are used on both links:

```text
 UI component  ── postMessage ──▶  host  ── stdin, one JSON object per line ──▶  backend
 (ui/*.js)     ◀─ message event ─        ◀─ stdout, "MSENTITY_JSON:" + JSON ───  (C++)
```

* The host forwards every backend message to the UI unchanged. Messages from
  the UI are translated into backend requests (and some open dialogs first);
  see [Host: messages from the UI](#host-messages-from-the-ui).
* Backend output lines that do not start with `MSENTITY_JSON:` are diagnostics;
  stderr carries error details. Neither is part of the protocol.
* Requests are handled in order. A failing request produces an error message
  and the backend keeps serving.

## Starting the backend

```console
msentity-viewer-backend dataset <file> [--page-size 20] [--file-type msds|msp|mgf|tsv|csv]
msentity-viewer-backend similarity <file.mssim> [--page-size 50]
```

Without `--file-type` the format comes from the extension. Paths in messages
are absolute (the backend resolves them); a dataset's id is its path, with
`#<random>` appended when the same file is loaded again.

## Dataset viewer (`dataset` mode, UI `ui/viewer.js` + `ui/spectrum.js`)

### Messages from the backend

| type | when | fields |
|---|---|---|
| `loading-progress` | while reading MSP/MGF | `file_type`, `processed`, `total` (bytes), `success`, `records`, `percent` |
| `backend-ready` | file loaded | `file`, `total_rows`, `page_size`, `dataset` {`id`, `name`, `path`, `total_rows`} |
| `error` | startup failed (the process then exits) or a request failed | `title`, `message` |
| `capabilities` | sent by the host after `backend-ready` | `chemistry` {`backend`, `smarts_filter`, `structure_render`, `structure_count`} |

### Requests

Every request may carry `dataset_id` (default: the opened file),
`structure_smiles_column` and `show_structure_column` (remembered for later pages).

| request | fields | answer |
|---|---|---|
| `page` | `page`, `filters`, `sort` | `dataset-page` or `filter-error` |
| `reload` | `filters`, `sort` | `dataset-reloaded`, then `dataset-page` (page 0) |
| `add-dataset` | `path`, `file_type` | `dataset-added` {`dataset`}, then `dataset-page` |
| `remove-dataset` | | `dataset-removed` {`dataset_id`} |
| `update-metadata` | `description`, `attributes` {name: text}, `tags` [text] | `metadata-updated` {`metadata`} |
| `update-cell` | `row_id`, `column`, `value` (text) | `metadata-updated` |
| `add-column` | `column`, `value` (initial text) | `column-added` {`column`} |
| `add-peak-column` | `column`, `value` | `peak-columns-updated` {`column`} |
| `get-peak-record` | `row_id` | `peak-record` {`row_id`, `modified`: false, `spectrum`} |
| `update-peak-cell` | `row_id`, `peak_index`, `column`, `value` | `peak-record` {`modified`: true} |
| `assign-spec-id` | `prefix`, `overwrite` | `spec-id-complete` {`total_rows`} or `spec-id-error` |
| `export` | `path`, `file_type`, `filters`, `sort`, `columns` | `export-start`, `export-progress`…, `export-complete` {`path`, `total_rows`} or `export-error` |
| `similarity-options` | | `similarity-options` {`datasets` [{`id`, `name`, `columns`}], `active_dataset_id`} |
| `calculate-similarity` | see below | `similarity-progress`…, `similarity-complete` {`path`, `total_rows`, `candidate_pairs`} or `similarity-error` |
| `column-values` | `request_id`, `column` or `detect_smiles`: true, `filters` | `column-values` {`request_id`, `column`, `values`, `row_ids`, `total_rows`} or {`error`} |
| `render-structure` | `smiles`, `width`, `height` | answered by the host: `structure-rendered` {`smiles`, `svg`} or `chemistry-error` |
| `calculate-structure-counts` | `filters` | answered by the host: `structure-counts` {`total_rows`, `smiles_column`, `unique_smiles`, `canonical_structures`} or `structure-counts-error` |

Edit requests that fail answer `edit-error` {`message`}. `row_id` is the
`row_ids` entry of a page: it identifies the spectrum regardless of filters,
sorting, and paging. Edited values keep the cell's type: `true`/`false` for
booleans, numbers for numeric cells (`"7"` stays an integer in an integer
column), text otherwise.

#### `dataset-page`

```jsonc
{
  "dataset_id": "/data/example.msp", "dataset_name": "example.msp", "dataset_path": "/data/example.msp",
  "columns": ["Name", "PrecursorMZ", ...],          // visible columns
  "all_columns": ["Name", "PrecursorMZ", ...],      // all columns of the dataset
  "rows": [{"Name": "MassSpecID0000001", "PrecursorMZ": "288.1225", ...}, ...],
  "row_ids": [0, 1],
  "spectra": [{"index": 0, "mz": [91.0542, ...], "intensity": [0.245, ...],
               "metadata_columns": ["formula"], "metadata": [{"formula": "C7H7+"}, ...]}, ...],
  "page": 0, "page_size": 20, "total_rows": 2, "total_pages": 1, "row_offset": 0,
  "structure_smiles_column": "SMILES",               // or null
  "show_structure_column": true,
  "description": "", "attributes": {}, "tags": []
}
```

Missing values, NaN, and infinities are `null`.

#### Filters and sorting

`filters` is a list of conditions that must all hold; `sort` is one
`{"column", "direction": "asc"|"desc"}` or a list in priority order (stable;
missing values last).

| operator | condition fields | matches |
|---|---|---|
| `text_eq`, `!=`, `contains` | `column`, `value` | the cell's text, case-insensitive |
| `numeric_eq`, `>`, `>=`, `<`, `<=` | `column`, `value` | numbers and numeric text; other cells never match |
| `spectrum_peak` | `mz`, `tolerance`, `tolerance_unit` (`Da`/`ppm`), `intensity` (0–1, relative to the base peak) | a peak within the tolerance |
| `neutral_loss` | as above, plus `precursor_column` (default `PrecursorMZ`) | a peak with precursor − m/z within the tolerance |
| `smarts` | `column`, `value` (pattern) | resolved by the host into `row_ids` |
| `row_ids` | `row_ids` | the listed spectra |

Conditions on unknown columns, or with an empty value, are ignored.

#### `calculate-similarity`

```jsonc
{"type": "calculate-similarity",
 "mode": "library_search",                 // or "by_key"
 "dataset1": "<query dataset id>",
 "dataset2": "<reference dataset id>",     // or "reference_path": "<file>"
 "path": "/data/result.mssim",             // must not be an input file
 "parameters": {"method": "cosine",        // or "reverse_cosine"
                "threshold": 0.8,           // library_search
                "key1": "SpecID", "key2": "SpecID",   // by_key
                "bin_width": 0.01, "intensity_exponent": 1.0, "threads": 0,
                "include_matched_data": true}}        // default: true for library_search, false for by_key
```

## Similarity result viewer (`similarity` mode, UI `ui/similarity.js`)

| request | fields | answer |
|---|---|---|
| `page` (UI: `page-request`) | `page`, `filters`, `sort` {`column`, `direction`}, `bins` (1–200) | `similarity-page` |
| `reload` | as `page` | rereads the file, then `similarity-page` |
| `match` (UI: `open-similarity-match` {`resultIndex`}) | `row` | `similarity-match` {`query`, `reference`, `method`} |
| `export` | `path` (`.mssim`, `.parquet`, `.csv`, `.tsv`), `filters`, `sort` | `export-complete` {`path`, `total_rows`} |

Errors answer `error` {`message`}. Filters here use the same operators except
that `text_eq` and `!=` are case-sensitive and unknown columns are errors.

`similarity-page`:

```jsonc
{
  "columns": ["index1", "index2", "cosine_similarity", "data_index1", "data_index2"],
  "rows": [...], "result_indices": [0, 1],     // row numbers in the result table
  "page": 0, "total_pages": 2, "page_size": 50, "total_rows": 4, "unfiltered_rows": 4,
  "metadata": {...},                           // the result's metadata.json
  "has_matched_data": true, "matched_data_rows": [2, 2],
  "histogram": {"counts": [...], "edges": [...]},   // of all filtered rows
  "statistics": {"mean": ..., "q1": ..., "median": ..., "q3": ..., "min": ..., "max": ...}
}
```

`similarity-match` sides (`query`, `reference`): `datasetName`, `datasetPath`,
`globalIndex` (position in the original input), `title`, `columns`, `row`
(metadata), and `spectrum` (as in `dataset-page`). A `.mssim` exported from the
viewer records `export_view` {`filters`, `sort`, `source_rows`} in its metadata.

## Spectrum panel (`ui/spectrum.js`)

The panel has no backend of its own. The host sends it:

* `{"type": "spectrum", "payload": {...}}` — one spectrum: `spectrum` (as in
  `dataset-page`), `row` (its metadata), `columns`, `globalIndex`, `rowId`,
  `title`, `datasetId`, `datasetName`, `datasetPath` (the dataset viewer posts
  this payload as `open-spectrum`);
* `{"type": "spectrum-comparison", "top": {...}, "bottom": {...}, "method": "cosine"}`;
* `peak-record` and `peak-columns-updated` from the dataset backend.

It posts `ready`, `add-peak-column`, `get-peak-record`, `edit-peak-cell`,
`save-image` {`filename`, `bytes`}, `save-peaks` {`contents` {`tsv`, `csv`}},
and notifications (`copy-notification`, `clipboard-error`, `export-error`).

## Host: messages from the UI

UI messages use camelCase fields (`datasetId`, `rowId`); backend requests use
snake_case (`dataset_id`, `row_id`). This is what
[`vscode/extension.js`](../vscode/extension.js) does with each message; another
host does the same with its own dialogs.

Dataset table (`ui/viewer.js`):

| UI message | host |
|---|---|
| `webview-ready` | sent once when the component listens for messages; the host holds backend messages until then |
| `ready` {`datasetId`} | `page` {`page`: 0} |
| `page-request` {`page`, `datasetId`, `filters`, `sort`} | `page` |
| `reload` {`datasetId`, `filters`, `sort`} | `reload` |
| `add-column` {`datasetId`, `column`, `value`} | `add-column` |
| `update-metadata` {`datasetId`, `description`, `attributes`, `tags`} | `update-metadata` |
| `edit-cell` {`datasetId`, `rowId`, `column`, `value`} | asks for the new value → `update-cell` |
| `remove-dataset` {`datasetId`} | asks for confirmation → `remove-dataset` |
| `add-dataset` | asks for a file → `add-dataset` {`path`} |
| `drop-datasets` {`paths`, `uris`, `files` [{`name`, `data` (base64)}]} | `add-dataset` for each (files are copied to a temporary directory) |
| `export-dataset` {`datasetId`, `datasetPath`, `filters`, `sort`, `columns`} | asks format and path → `export` {`path`, `file_type`, …}; cancelled: UI `export-cancelled` |
| `assign-spec-id` {`datasetId`, `hasSpecId`} | asks the prefix (and confirms replacement) → `assign-spec-id`; cancelled: UI `spec-id-cancelled` |
| `calculate-similarity` {`datasetId`} | `similarity-options`, dialogs → UI `similarity-start`, `calculate-similarity`; cancelled: UI `similarity-cancelled` |
| `render-structure` {`smiles`} | `render-structure` {`smiles`, `width`, `height`} |
| `calculate-structure-counts` {`datasetId`, `filters`} | `calculate-structure-counts` |
| `open-spectrum` {`payload`} | shows the payload in the spectrum component (`spectrum`) |
| `*-notification`, `open-settings`, `show-logs` | shows a message, the settings, or the logs |

Similarity result (`ui/similarity.js`): `webview-ready` as above; `page-request` → `page`, `reload` →
`reload` (both with `page`, `filters`, `sort`, `bins`); `open-similarity-match`
{`resultIndex`} → `match` {`row`}, whose answer opens a `spectrum-comparison`;
`export-similarity` {`filters`, `sort`} → asks format and path → `export`;
`save-similarity-image` {`filename`, `bytes`} → saves the file and answers
`image-save-complete` / `image-save-cancelled` / `image-save-error`.

Spectrum (`ui/spectrum.js`): `add-peak-column` and `get-peak-record`
{`datasetId`, `rowId`} go to the backend of the dataset the spectrum came from;
`edit-peak-cell` {`datasetId`, `rowId`, `peakIndex`, `column`, `value`} asks for
the value → `update-peak-cell`; `save-image` and `save-peaks` save files.

## Chemistry (`host/chemistry/`, RDKit)

The host answers the chemistry requests with RDKit's WebAssembly build
(`@rdkit/rdkit`), which runs in a Node.js worker thread
(`host/chemistry/worker.js`). `RdkitChemistry.call`
takes:

| request | result |
|---|---|
| `smarts-match` {`values`, `pattern`} | `[true, false, ...]`, one per value; invalid SMILES never match |
| `structure-counts` {`values`} | {`unique_smiles`, `canonical_structures`} (distinct non-empty SMILES, distinct canonical SMILES) |
| `render` {`smiles`, `width`, `height`} | {`smiles`, `svg`} (width and height limited to 200–1200) |

Errors (`Invalid SMARTS pattern`, `Invalid SMILES`, `… requires optional RDKit
support`) reject the call; the session reports them to the UI as
`filter-error`, `chemistry-error`, or `structure-counts-error`. Capabilities
are enabled only when RDKit's smoke tests pass, and
`MSENTITY_SPECTRUM_VIEWER_DISABLE_RDKIT=1` turns them off.
