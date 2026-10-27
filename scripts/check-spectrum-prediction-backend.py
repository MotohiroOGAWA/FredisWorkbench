from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import torch

import fredis
APP_ROOT = Path(next(iter(fredis.__path__))).resolve().parent
sys.path.insert(0, str(APP_ROOT))
backend_path = (
    Path(__file__).resolve().parents[1] / "src/features/spectrum-prediction/backend.py"
)
spec = importlib.util.spec_from_file_location(
    "spectrum_prediction_backend", backend_path
)
backend = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(backend)


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.integration.test_prediction_adapters import prepared
from fredis.libs.mmkit.mmkit import Compound, Adduct

model, _ = prepared()
model.eval()
source = Compound.from_smiles("CCO")
result = model.predict([source], [Adduct.parse("[M+H]+")], [20.0])
serialized = backend._build_tree(result, 0, model.tensorizer, 0.0)
node_ids = {node["id"] for node in serialized["nodes"]}
assert len(node_ids) > 1 and serialized["edges"]
assert all(
    edge["source"] in node_ids and edge["target"] in node_ids and edge["transitions"]
    for edge in serialized["edges"]
)
assert any(
    node["precursor"] and [] in node["reactionSets"] for node in serialized["nodes"]
)
assert any(node["annotations"] for node in serialized["nodes"])
json.dumps(serialized)

from fredis.domain.fragment.fragmenter import Fragmenter
from fredis.libs.mmkit.mmkit import Compound

fragmenter = Fragmenter.from_dict(
    json.loads(
        (
            APP_ROOT / "fredis/presets/fragment/single_bond_cleavage_pos.fragmenter.pft"
        ).read_text()
    )
)
source = Compound.from_smiles("CCOC(=O)C")
real_reactions = tuple(
    fragmenter.fragment_ion_tree_builder.create_reaction_instances(source)
)
registry = backend._reaction_registry(
    SimpleNamespace(fragmenter=fragmenter), real_reactions
)
assert len(registry) == len(real_reactions) > 0
assert all(
    {
        "id",
        "reactionPatternId",
        "reactionRuleId",
        "sourceAtomMaps",
        "retainedAtomMaps",
        "cutBondMaps",
    }
    <= row.keys()
    for row in registry
)

print(
    "Single-spectrum prediction tree preserves selectable edge transitions and reaction histories."
)

# The single-prediction UI defaults to zero and accepts a numeric intensity cutoff.
from dataclasses import replace
from tempfile import NamedTemporaryFile
from unittest.mock import patch

model.set_generation(replace(model.generation, peak_intensity_threshold=0.5))
with NamedTemporaryFile(suffix=".pt") as checkpoint:
    request = {
        "modelPath": checkpoint.name,
        "smiles": "CCO",
        "ce": "20",
        "adductType": "[M+H]+",
    }
    with patch.object(backend, "load_generator", return_value=model):
        unfiltered = backend.predict(request)
        filtered = backend.predict({**request, "peakIntensityThreshold": 0.5})
    assert any(p["intensity"] <= 0.5 for p in unfiltered["peaks"])
    assert all(p["intensity"] > 0.5 for p in filtered["peaks"])
    assert len(filtered["peaks"]) < len(unfiltered["peaks"])
    assert {a["mapNumber"] for a in unfiltered["sourceAtoms"]} >= {
        m for row in unfiltered["reactions"] for m in row["sourceAtomMaps"]
    }
    assert all(0 <= a["x"] <= 620 and 0 <= a["y"] <= 360 for a in unfiltered["sourceAtoms"])
    # Attention weights are exported for every tree node and concrete reaction.
    attention = unfiltered["attention"]
    scale = attention["scale"]
    assert set(attention["molecule"]["nodes"]) == {
        str(node["id"]) for node in unfiltered["tree"]["nodes"]
    }
    assert set(attention["reactions"]) == {
        str(row["id"]) for row in unfiltered["reactions"]
    }
    for item in [
        *attention["molecule"]["nodes"].values(),
        *attention["reactions"].values(),
    ]:
        for layer in item["weights"]:
            for head in layer:
                assert all(abs(sum(row) - scale) <= len(row) for row in head)
    for reaction in unfiltered["reactions"]:
        positions = attention["reactions"][str(reaction["id"])]["positions"]
        assert [p["mapNumber"] for p in positions] == reaction["sourceAtomMaps"]
    transformers = attention["transformers"]
    assert "encoder" in transformers
    assert any(key.startswith("self-") for key in transformers)
    assert any(key.startswith("cross-") for key in transformers)
    for key, entry in transformers.items():
        assert entry["layers"] > 0 and entry["heads"] > 0
        for layer in entry["weights"]:
            for head in layer:
                assert len(head) == len(entry["tokens"])
                assert all(len(row) == len(entry["keyTokens"]) for row in head)
                assert all(abs(sum(row) - scale) <= len(row) for row in head)
        if key.startswith(("self-", "cross-")):
            assert entry["tokens"][:3] == ["BOS", "Main adduct", "Root molecule"]
    # Capturing attention must not leave hooks or alter ordinary prediction.
    assert not model.feature_model._forward_pre_hooks
    assert not model.feature_model.state_decoder.decoder._forward_hooks
    # Peaks are merged per ion formula; contributors sum to the peak intensity.
    formulas = [p["formula"] for p in unfiltered["peaks"]]
    assert len(formulas) == len(set(formulas))
    for p in unfiltered["peaks"]:
        assert p["contributors"]
        assert abs(sum(c["intensity"] for c in p["contributors"]) - p["intensity"]) < 1e-6
print("Single-spectrum intensity threshold defaults to zero and accepts numeric values.")

# Recording uses the actual attention path and preserves prediction values.
with torch.no_grad(), backend._capture_reaction_transformers(model.feature_model) as records:
    captured = model.predict([source], [Adduct.parse("[M+H]+")], [20.0])
with torch.no_grad():
    ordinary = model.predict([source], [Adduct.parse("[M+H]+")], [20.0])
torch.testing.assert_close(captured.spectra.mz, ordinary.spectra.mz)
torch.testing.assert_close(captured.spectra.intensity, ordinary.spectra.intensity)

# An empty reaction memory has no reaction key; its internal fallback is hidden.
empty_source = Compound.from_smiles("C")
with torch.no_grad(), backend._capture_reaction_transformers(model.feature_model) as records:
    model.predict([empty_source], [Adduct.parse("[M+H]+")], [20.0])
empty = backend._transformer_attention(records, ())
assert "encoder" not in empty
assert any(key.startswith("cross-") for key in empty)
for key, entry in empty.items():
    if key.startswith("cross-"):
        assert entry["keyTokens"] == []
        assert all(not row for layer in entry["weights"] for head in layer for row in head)
print("Reaction Transformer attention preserves predictions and handles empty memories.")
