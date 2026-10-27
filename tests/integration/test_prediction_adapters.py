"""Shared graph training, teacher-free prediction, batching and Workbench regressions."""

from dataclasses import fields, replace
from importlib.util import spec_from_file_location, module_from_spec
from unittest.mock import patch, PropertyMock
import json
import torch
import pytest
from fredis.libs.mmkit.mmkit import Compound, Adduct
from fredis.domain.fragment.reaction import ReactionSequence
from fredis.ml.input.source_reaction_structure import (
    SourceReactionStructure,
    SpectrumPredictionData,
)
from fredis.ml.input.structure_builder import ReactionStructureBuilder
from fredis.ml.specgen.spectrum_generator import create_spectrum_generator
from fredis.ml.training.fragment_tree_training.model import (
    ReactionFragmentTreeTrainingModel,
)
from .reaction_config import config


def prepared():
    torch.manual_seed(17)
    model = create_spectrum_generator(config())
    source = Compound.from_smiles("CC(O)N")
    adduct = Adduct.parse("[M+H]+")
    data, _ = ReactionStructureBuilder(model).build(
        source,
        [adduct, adduct],
        [10.0, 40.0],
        [[18.033826, 44.049476], [18.033826, 44.049476]],
        [[0.5, 1.0], [1.0, 0.5]],
    )
    return model, data

def test_workbench_shows_group_labels_and_ce_specific_formula_assignments(tmp_path):
    _, data = prepared()
    path = tmp_path / "view.preft.pt"
    data.save(path)
    spec = spec_from_file_location(
        "canonical_workbench",
        "src/features/fragment-tree-result/backend.py",
    )
    backend = module_from_spec(spec)
    spec.loader.exec_module(backend)
    output = backend.inspect_structure(path)
    json.dumps(output)
    assert len(output["branchGroups"]) == 1 and len(output["samples"]) == 2
    assert all(
        {"retainedAtomMaps", "discardedAtomMaps", "cutBondMaps", "changedBondMaps"}
        <= row.keys()
        for row in output["reactions"]
    )
    labels = {e["id"]: e["label"] for e in output["branchGroups"][0]["edges"]}
    assert set(labels.values()) <= {-1, 0, 1} and 1 in labels.values()
    assert (
        output["samples"][0]["collisionEnergy"]
        != output["samples"][1]["collisionEnergy"]
    )
    assert (
        output["samples"][0]["peaks"][0]["intensity"]
        != output["samples"][1]["peaks"][0]["intensity"]
    )
    for sample in output["samples"]:
        assert {e["id"]: e["label"] for e in sample["edges"]} == labels
        for peak in sample["peaks"]:
            for match in peak["matches"]:
                assert match["nodeIds"] == [match["compoundIndex"]]
                assert "formulaExplanationIndex" in match

def test_workbench_single_prediction_backend_uses_shared_compound_ids(tmp_path):
    model, _ = prepared()
    model.eval()
    spec = spec_from_file_location(
        "canonical_prediction_backend",
        "src/features/spectrum-prediction/backend.py",
    )
    backend = module_from_spec(spec)
    spec.loader.exec_module(backend)
    checkpoint = tmp_path / "model.pt"
    checkpoint.touch()
    with patch.object(backend, "load_generator", return_value=model):
        result = backend.predict(
            dict(
                smiles="CCO",
                adductType="[M+H]+",
                ce="20",
                modelPath=str(checkpoint),
                device="cpu",
            )
        )
    json.dumps(result)
    reaction_attention = result["attention"]["reactions"]
    assert reaction_attention
    for attention in reaction_attention.values():
        assert attention["graphTokens"] == 0
        assert len(attention["keyAtoms"]) == 3
        for layer in attention["weights"]:
            for head in layer:
                assert len(head) == len(attention["positions"])
                assert all(len(row) == len(attention["keyAtoms"]) for row in head)
                assert all(abs(sum(row) - result["attention"]["scale"]) <= 3 for row in head)
    nodes = {row["id"] for row in result["tree"]["nodes"]}
    assert len(nodes) > 1 and result["tree"]["edges"]
    assert all(
        edge["transitions"] and edge["source"] in nodes and edge["target"] in nodes
        for edge in result["tree"]["edges"]
    )
    assert all(c["nodeId"] in nodes for peak in result["peaks"] for c in peak["contributors"])

