<h1><img src="media/icon.png" alt="msentity icon" width="48" height="48" align="center"> msentity Spectrum Viewer for VS Code</h1>

Graphical viewer for mass-spectrometry datasets — MSDS, MSP, MGF, TSV, and
CSV — and for spectrum similarity results (`.mssim`). Data is read by
[msentity](https://github.com/MotohiroOGAWA/msentity), a C++ library that ships
inside the extension, so nothing else needs to be installed.

## Features

- Paged spectrum metadata table with reorderable columns and one reusable spectrum panel
- Full-dataset, multi-condition filtering (text/number `=`, text `!=`, `contains`, `>`, `>=`, `<`, `<=`,
  peaks within an m/z tolerance, neutral losses) and prioritized multi-column sorting
- Edit dataset description, attributes, tags, metadata cells, and peak annotations; add columns
- Assign sequential SpecID values with an optional prefix
- MSP/MGF loading progress with bytes, percentage, and spectrum count
- Export to MSDS, MSP, MGF, TSV, or CSV using the visible columns and current filters/sort order
<!-- rdkit:start -->
- SMARTS substructure filtering, 2D structure previews, and structure counts (RDKit, included)
<!-- rdkit:end -->
- Multiple datasets in one viewer; drag and drop files to add them
- Mirrored two-spectrum comparison with dot product, reverse dot product, modified dot product, and BONANZA scores
- Library search and key matching saved as `.mssim`, with a dedicated result viewer (histogram, box plot, statistics, filters)
- Peak table copy/save as TSV or CSV; drag-to-zoom; PNG/SVG export and clipboard copy
- VS Code light, dark, and high-contrast theme support

## Install

Download the VSIX for your platform from the
[Releases](https://github.com/MotohiroOGAWA/msentity-spectrum-viewer/releases)
page and install it:

```console
code --install-extension msentity-spectrum-viewer-<version>-<platform>.vsix
```

or use **Extensions → Views and More Actions (...) → Install from VSIX...**.
Each package contains the viewer backend for one platform: Linux x64
(`linux-x64`) or Windows x64 (`win32-x64`). macOS is not supported.

Two variants are published for each platform; install one of them:

| File | Contents |
|---|---|
| `msentity-spectrum-viewer-<version>-<platform>.vsix` | everything, including the chemistry features (RDKit) |
| `msentity-spectrum-viewer-no-rdkit-<version>-<platform>.vsix` | the same without RDKit (smaller; no SMARTS filters or structure previews) |

<!-- rdkit:start -->
## Chemistry features (RDKit)

SMARTS substructure filters, 2D structure previews, and SMILES/structure
counts use [RDKit](https://www.rdkit.org/), whose WebAssembly build is
included in the extension: nothing has to be installed. RDKit runs in a
background thread, so long SMARTS searches do not block VS Code.

Structure previews use the metadata column configured by
`msentitySpectrumViewer.structureSmilesColumn`, which defaults to `SMILES` and
matches column names case-insensitively. Known canonical and isomeric SMILES
column names are used as fallbacks; without any of them the Structure column
is not shown. After changing the setting, use **Reload** in the Viewer. The
Structure column can be hidden, and the rendered SVG width and height can be
adjusted in the settings (**More ... → Settings**).
<!-- rdkit:end -->
<!-- no-rdkit:start -->
## Chemistry features

This package does not include RDKit, so SMARTS substructure filters, structure
previews, and structure counts are not available. Install the package without
`no-rdkit` in its name to use them.
<!-- no-rdkit:end -->

## Usage

Open an `.msds`, `.msp`, or `.mgf` file normally. For TSV or CSV, use **MS
Entity: Open as...** and select **tsv** or **csv** so ordinary tabular files
remain associated with VS Code's normal text editor. Click a spectrum button in the table;
the reusable **Mass Spectrum** panel opens and updates when another record is
selected. Use **Add dataset…** to load more files into the same dataset viewer,
then switch between them with the dataset dropdown. Spectra opened from those
datasets share the same Mass Spectrum panel, while datasets opened in separate
VS Code tabs continue to use separate spectrum panels. Each dataset remembers
its current page when you switch away and return.

Pin the upper spectrum and select another spectrum to compare them on a shared
m/z axis. The second spectrum is drawn downward in red. Each side can be pinned
independently: new selections replace the unpinned side, and neither side
changes while both are pinned. The lower spectrum can also be removed. While
comparing, similarity is calculated automatically with a selectable dot
product, reverse dot product, modified dot product, or BONANZA score. Fragment
matching tolerance is editable in Da and defaults to ±0.05 Da. Modified dot
product and BONANZA also consider precursor-mass-shifted neutral-loss matches.
The score and matched-peak count update when the method or tolerance changes.
The metadata area below the plot shows separate **Upper Metadata** and **Lower
Metadata** panels during comparison, using the columns from each spectrum's
source dataset.
Drag horizontally to zoom m/z only, vertically to zoom intensity
only, or diagonally to zoom both axes. Choose **Export image...**, select the
elements to include, set any output width and height in pixels, and save the
visible plot as a transparent PNG or SVG. The requested dimensions are filled
even when their aspect ratio differs from the plot. **Copy PNG** and **Copy
SVG** copy the current preview to the clipboard. Tick grid lines are excluded
by default. Plot geometry follows the requested aspect ratio, while axis,
tick, and peak-label text keeps its original size and character proportions.
The exported image uses the current zoom range and leaves 10% intensity
headroom so labels above maximum-intensity peaks remain readable.
When both kinds of tick numbers are disabled, export compacts the axis-title
spacing and unused margins. Click empty plot space to clear peak selection; double-click
the plot to reset both zoom axes.

Use **Copy TSV** or **Copy CSV** above the peak table to copy its complete,
unrounded values. **Save…** first asks for TSV or CSV and then opens the file
save dialog. A single spectrum has `m/z` and `Intensity` columns. A comparison
has separate Upper and Lower columns; peaks within the current tolerance share
a row, while an unmatched peak leaves the other side empty. Ascending or
descending m/z order is preserved independently on both sides. Export always
includes the complete spectra, independent of the current plot zoom.

Opening normally detects MSDS, MSP, or MGF from the extension. TSV and CSV are
intentionally not registered as custom-editor file extensions. To open one as a spectrum table,
right-click a file in Explorer and choose **MS Entity: Open as...**, then select **msds**, **msp**, **mgf**,
**tsv**, or **csv**. The same command is available in the Command Palette. Dataset **Export...** first asks for MSDS, MSP, MGF, TSV, or CSV and then for the
save location; the chosen format takes precedence and its extension is applied
automatically. The exported dataset contains the currently selected columns in
their displayed order and the rows in their current filtered and sorted order.

Set `msentitySpectrumViewer.spectrumFloatingWindow` to `false` if the spectrum
should remain in an editor pane beside the dataset table.

## Calculate similarity and run a library search

Click **Calculate similarity…** next to **Reload**, then choose **Library
search** or **Match by metadata key**. A library search compares every spectrum
in the query dataset with every spectrum in a reference library. The reference
can be an entry already loaded with **Add dataset…**, or an MSDS, MSP, MGF, TSV,
or CSV file selected for that calculation. Choose cosine or reverse cosine,
set the score threshold (default `0.8`), the m/z bin width, and the intensity
exponent before saving the result as **`.mssim`**. Scores are calculated by
[msentity-similarity](https://github.com/MotohiroOGAWA/msentity-similarity)
on all CPU cores.

Metadata-key matching preserves the previous workflow. Select two loaded
datasets and a key for each side. Non-missing keys must be unique within each
dataset. Duplicate values produce an error because they create one-to-many or
many-to-many pairings. Missing keys and keys present on only one side are
skipped.

Both modes use the entire loaded datasets, including unsaved SpecID edits;
table filters do not restrict calculation. Choose **Include matched data** to
make the result self-contained, or **Lightweight result** to save only indices,
scores, and calculation metadata. Embedded results store each unique matched
record once and refer to it by number from every result row, so one spectrum
matching many candidates does not duplicate its metadata or peaks.

The `.mssim` file opens in a dedicated **Similarity Viewer**:

- Embedded results show **Open spectra** on each row to open the saved query
  and reference records as a mirrored spectrum comparison.
- **Filter**: combine numeric comparisons and key/text conditions.
- Click a column heading to sort; use Previous/Next for paging.
- The histogram and count/mean/Q1/median/Q3/min/max summarize all filtered rows,
  not just the current page. Choose 1–200 bins; click a bar or use the accessible
  frequency table to filter a similarity range. The final bin includes 1.0.
- Switch between a histogram and a box plot. Histogram counts support linear and
  log10 scales.
- **Save PNG…** opens an image preview where width, height, grid visibility,
  histogram color, box color, and count scale can be changed before saving.
- **Export…**: save the filtered/sorted results as `.mssim`, TSV, CSV, or Parquet.
  Only `.mssim` preserves calculation metadata, embedded matched data, and the
  export filter definition. Unreferenced embedded records are removed.
- **Reload**: reread the result from disk, retaining active filters. It does not
  recalculate spectra. Start another calculation from the dataset viewer to do so.
- Expand **Calculation metadata** to inspect parameters, creation time, input
  paths, dataset descriptions/attributes/tags, and row counts.

The result opens independently of the source files. The file format is
specified in msentity-similarity's
`docs/format/mssim.md`;
the same calculations are available on the command line with `mssim-tool`.

## Edit metadata and remove added datasets

Click **Metadata…** to view and edit the active dataset's description,
attributes (name/value pairs), and tags (one per line). **Apply** updates the
loaded dataset; **Cancel** discards the form draft. Attribute names must be
nonempty and unique.

Double-click a spectrum metadata cell, or focus it and press **Enter**, to
edit its value. Numeric cells require finite numbers; boolean cells accept
true or false. Editing targets the original spectrum even after filtering,
sorting, or paging.

Use **Export…** to save applied changes. Choose **MSDS** to preserve dataset
description, attributes, and tags. Export still respects filters and visible
columns; clear filters and select all columns to save the entire dataset.
The Modified indicator records changes since loading and stays visible after
export because an export may contain only a subset. Reload or closing the
viewer discards changes that have not been exported.

Select a dataset added with **Add dataset…**, then click **Remove dataset**.
After confirmation it is removed from this viewer and from similarity choices;
its file stays on disk. The viewer returns to the original dataset and clears
the spectrum panel. The original dataset is removed by closing its editor tab.

## Add metadata and peak annotation columns

Open **Columns** in the dataset table and click **+**. Enter a column name and an optional
initial value in the same form, then click **Add**. The initial value defaults
to an empty string. The new column is visible immediately and applies to all
spectra in the selected dataset, including rows outside the current filter or
page. Existing columns cannot be overwritten by adding a column.

The spectrum panel's **Peaks** table displays stored peak annotation columns
beside m/z and intensity. The **Columns** button sits in the spectrum header
next to **Export image…**. Toggle annotation columns and use the arrow buttons to change their order.
**All columns** selects or clears annotation columns. m/z and Intensity remain
visible as the first two columns and are not listed in this menu. Display settings are remembered per dataset while the panel is open,
and column changes preserve zoom, peak selection, and sorting.

Click **+** inside this menu to reveal the column-name and initial-value form.
In a comparison, choose **Upper** or **Lower** to select the dataset to modify. A new peak annotation column applies to all peaks in
that dataset; its default value is blank.

Double-click an annotation cell, or focus it and press **Enter**, to edit that
peak. Annotation values follow their original peaks when the table is sorted
or two spectra are aligned. Copy/Save TSV and CSV follow the visible column selection and order.
Embedded similarity results display saved annotations as read-only.

Use dataset **Export… → MSDS** to persist peak annotations with the dataset.
The dataset's MGF/TSV/CSV export formats do not preserve these added peak
annotation columns. MSDS also preserves columns whose values are all blank.

## Assign SpecID

Click **Assign SpecID…** and enter a prefix (or leave it empty). IDs start at 1
and are zero-padded to the largest number: 12 spectra with prefix `SP` receive
`SP01` through `SP12`. This assigns IDs to every spectrum in the active dataset
in its original order, regardless of filters, sorting, or the current page.
Existing SpecID values are replaced only after confirmation.

The table refreshes after assignment. Use **Export…** with the SpecID column
selected to save the changes. Export respects current filters and visible
columns; clear filters to export all spectra. **Reload** or closing the viewer
discards assignments that have not been exported.

## Settings

- `msentitySpectrumViewer.pageSize`: spectra per metadata page (default: `20`).
- `msentitySpectrumViewer.spectrumFloatingWindow`: use a separate floating
  window for the spectrum (default: `true`).
<!-- rdkit:start -->
- `msentitySpectrumViewer.structureSmilesColumn`, `showStructureColumn`,
  `structurePreviewWidth`, `structurePreviewHeight`: structure previews.
<!-- rdkit:end -->
- `msentitySpectrumViewer.backendPath`: use another `msentity-viewer-backend`
  executable (development builds).

## More

Image export **Advanced** settings include upper/lower peak colors, m/z range, separate upper/lower intensity ranges, peak line width, and peak label size, color, decimal places, and top K by intensity per spectrum. Blank ranges follow the current view; 0 for top K labels all visible peaks. Enable **m/z above peaks** to show labels. Settings persist across spectrum selections and webview restoration, and apply to preview, PNG/SVG saves, and clipboard copies.

Use **Reset export defaults** in Advanced to reset all image export options, including dimensions and visibility toggles. Axis ranges are displayed as minimum ～ maximum.

The dataset dropdown contains compact **Add dataset** and **Remove dataset** icon buttons above the dataset list. You can also drop one or more MSDS, MSP, MGF, TSV, or CSV files anywhere in the Dataset Viewer to add them. Files dropped from the OS are imported as temporary copies when no workspace path is available; these copies are removed when the viewer closes.

Any dataset, including the first one opened, can be removed from the viewer. Removing the active dataset selects a remaining dataset. Removing the last dataset shows an empty view where Add dataset and file drops remain available. Removal does not delete the source file.

Adding the same file again creates an independent dataset loaded from its current on-disk contents. In-memory edits to an existing dataset are preserved. Datasets with matching filenames receive unique display names such as `sample (1).msp` and `sample (2).msp`, including files from different directories. These names also appear in spectrum views and similarity selection.

The toolbar provides **Reload**, **Filter**, and **Export** directly. **More ...** contains Metadata, Columns, Assign SpecID, and Calculate similarity. Press **Ctrl+S** while the Dataset Viewer is focused to open the same Export flow.

Logs of the backend: **MS Entity: Show Spectrum Viewer Logs**.
<!-- rdkit:start -->

RDKit is distributed under the BSD-3-Clause license; see `THIRD-PARTY-NOTICES.txt`.
<!-- rdkit:end -->
