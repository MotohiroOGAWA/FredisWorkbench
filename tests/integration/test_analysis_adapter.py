"""PatternSet-tree Reaction Pattern Analysis: tree configuration, cumulative node
conditions, edge comparisons, cached Source reactions, A/B/C result layout,
lazy reading and adding nodes to an existing result.

Fixture chemistry (every set holds one pattern of nonring_single_bond):

    CCO  4 spectra: [M+H]+ CE10/CE20 + [M+Na]+ CE20 (dataset 1), [M+H]+ CE40 (dataset 2)
         ("OCC" in dataset 1 is the same compound)
    CC   1 spectrum with only its precursor peak

    H (halogen)  matches nothing    → root trees assign only the precursor
    O            matches CCO        → new peaks
    N            matches nothing    → edge never applies
    C            matches CCO and CC

Tree::

    H ─┬─ O ─── C        (H, H+O, H+O+C)
       └─ N              (H+N == H for every compound)
    C ─── O              (C, C+O)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
import pytest

from fredis.analysis.reaction_pattern import ReactionPatternAnalysisResult, TreeConfiguration, generate_reaction_pattern_analysis
from fredis.analysis.reaction_pattern import applicability, chemistry
from fredis.analysis.reaction_pattern.compounds import compound_id_for
from fredis.analysis.reaction_pattern.constants import assigned_column, count_column
from fredis.analysis.reaction_pattern.summary import distribution
from fredis.analysis.reaction_pattern.tree import PatternRegistry, resolve_tree

PATTERN_SET = Path(next(iter(__import__("fredis").__path__))) / Path("presets/fragment/reaction_pattern_sets/nonring_single_bond/nonring_single_bond.reactionset.pft")
PEAKS = [[47.049, 1.0], [31.018, 0.6], [29.039, 0.3], [19.018, 0.2], [15.023, 0.1]]
CCO, CC = compound_id_for("CCO"), compound_id_for("CC")
NAMES = {"H": "nonring_halogen_single_bond", "O": "nonring_o_single_bond", "N": "nonring_n_single_bond",
         "C": "nonring_c_single_bond"}


def _patterns() -> dict:
    return {row["name"]: row for row in json.loads(PATTERN_SET.read_text())["reaction_pattern_set"]["patterns"]}


def _set(key: str, *names: str) -> dict:
    patterns = _patterns()
    return {"id": key, "name": key, "patterns": [patterns[NAMES[name]] for name in (names or (key,))]}


def _tree(*extra_nodes: dict, extra_sets=()) -> dict:
    return {"patternSets": [_set("H"), _set("O"), _set("N"), _set("C"), *extra_sets],
            "nodes": [{"id": "h", "patternSet": "H", "parent": None},
                      {"id": "ho", "patternSet": "O", "parent": "h"},
                      {"id": "hoc", "patternSet": "C", "parent": "ho"},
                      {"id": "hn", "patternSet": "N", "parent": "h"},
                      {"id": "c", "patternSet": "C", "parent": None},
                      {"id": "co", "patternSet": "O", "parent": "c"}, *extra_nodes]}


def _dataset(path: Path, rows: list[tuple[dict, list]]) -> Path:
    from fredis.data import MSDataset
    from fredis.data.core.PeakSeries import PeakSeries

    peaks = [peak for _, values in rows for peak in values]
    offsets = np.cumsum([0] + [len(values) for _, values in rows])
    MSDataset(pd.DataFrame([row for row, _ in rows]),
              PeakSeries(np.asarray(peaks, dtype=float), np.asarray(offsets, dtype=np.int64))).save(str(path))
    return path


def _spectrum(smiles, adduct, energy, precursor):
    return {"SMILES": smiles, "AdductType": adduct, "CollisionEnergy": energy, "PrecursorMZ": precursor}


def _chemistry(max_reaction_count: int = 2) -> dict:
    from .reaction_config import chemistry

    value = chemistry()
    builder = value["fragmenter_params"]["fragment_ion_tree_builder"]
    builder["max_reaction_count"] = max_reaction_count
    # Patterns of the chemistry configuration never enter the analysis.
    builder["reaction_pattern_set"] = {"name": "ignored", "patterns": [_patterns()[NAMES["O"]]]}
    return value


@pytest.fixture(scope="module")
def inputs(tmp_path_factory):
    root = tmp_path_factory.mktemp("analysis-inputs")
    first = _dataset(root / "first.msds", [
        (_spectrum("CCO", "[M+H]+", 10, 47.049), PEAKS),
        (_spectrum("OCC", "[M+H]+", 20, 47.049), PEAKS[:3]),
        (_spectrum("CC", "[M+H]+", 20, 31.054), [[31.054, 1.0]]),
        (_spectrum("CCO", "[M+Na]+", 20, 69.031), [[69.031, 1.0], [53.0, 0.5]]),
    ])
    second = _dataset(root / "second.msds", [(_spectrum("CCO", "[M+H]+", 40, 47.049), PEAKS)])
    return [first, second]


def _run(output: Path, inputs, tree=None, **kwargs) -> Path:
    return generate_reaction_pattern_analysis(sources=[{"path": str(path)} for path in inputs], output_dir=output,
                                      chemistry_config=_chemistry(), tree=tree or _tree(), overwrite=True, **kwargs)


@pytest.fixture(scope="module")
def analysis(tmp_path_factory, inputs):
    """One run with spies on worker tasks and Source reaction enumeration."""
    from fredis.domain.fragment import reaction as reaction_package

    tasks, reactions = [], []
    original_task, original_reactions = chemistry.run_task, reaction_package.create_reaction_instances
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(chemistry, "run_task", lambda task: tasks.append(
            (task.compound.compound_id, [(step.condition_id, step.parent_condition_id) for step in task.steps]))
            or original_task(task))
        patch.setattr(reaction_package, "create_reaction_instances", lambda source, pattern_set: reactions.append(
            (source.smiles, tuple(pattern.name for pattern in pattern_set))) or original_reactions(source, pattern_set))
        result = _run(tmp_path_factory.mktemp("analysis-result") / "result", inputs)
    with ReactionPatternAnalysisResult(result) as reader:
        nodes = {row["node_id"]: row for row in reader.node_summary()}
    return {"path": result, "tasks": tasks, "reactions": reactions, "nodes": nodes}


# -- Tree Configuration ----------------------------------------------------------------






# -- calculation -----------------------------------------------------------------------------






# -- edge comparison ----------------------------------------------------------------------------








# -- A/B/C layout -------------------------------------------------------------------------------






# -- reader ---------------------------------------------------------------------------------------










# -- adding nodes to an existing result -------------------------------------------------------------




# -- CLI / Workbench backend ------------------------------------------------------------------------


def test_workbench_backend_answers_tree_queries(analysis):
    import importlib.util

    path = Path("src/features/reaction-pattern-analysis/backend.py")
    spec = importlib.util.spec_from_file_location("reaction_pattern_analysis_backend", path)
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    info = backend.run({"action": "info", "path": str(analysis["path"])})
    assert info["tree"]["configuration"]["nodes"][1]["parent"] == "h"
    node_row = analysis["nodes"]["ho"]["node_row"]
    distribution_rows = backend.run({"action": "nodeDistribution", "path": str(analysis["path"]), "nodeRow": node_row})
    assert distribution_rows["rows"]
    peaks = backend.run({"action": "compoundPeaks", "path": str(analysis["path"]), "compoundId": CCO})
    detail = backend.run({"action": "peakDetail", "path": str(analysis["path"]), "compoundId": CCO,
                          "sampleId": peaks["rows"][0]["sample_id"], "peakIndex": peaks["rows"][0]["peak_index"],
                          "nodeRow": node_row})
    assert "precursorSvg" in detail
