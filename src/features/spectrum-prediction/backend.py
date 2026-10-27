"""Backend for predicting a single MS/MS spectrum from SMILES + CE + adduct."""

from __future__ import annotations


import contextlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, ".")

from fredis.domain.fragment.reaction.ReactionRelations import ReactionRelations

import torch
from rdkit import Chem
from rdkit.Chem import rdDepictor
from rdkit.Chem.Draw import rdMolDraw2D

from fredis.libs.mmkit.mmkit import Adduct, Compound, Formula
from fredis.domain.mass.parse_ce import parse_ce_to_ev
from fredis.ml.specgen.predict_spectrum import load_generator
from fredis.ml.common.layers.multihead_attention import MultiheadAttention


def _reaction_id(reactions, reaction) -> int | None:
    if reaction is None:
        return None
    try:
        return reactions.index(reaction)
    except ValueError as exc:
        raise ValueError(
            "Predicted tree transition references an unknown reaction."
        ) from exc


def _reaction_registry(generator, reactions) -> list[dict[str, Any]]:
    """Describe the same primitive Source reactions used during prediction."""
    patterns = {
        pattern.pattern_id: pattern
        for pattern in generator.fragmenter.fragment_ion_tree_builder.reaction_pattern_set
    }
    registry = []
    for number, reaction in enumerate(reactions):
        pattern = patterns.get(reaction.reaction_pattern_id)
        rule = (
            next(
                (
                    item
                    for item in pattern.reaction_rules
                    if item.id == reaction.reaction_rule_id
                ),
                None,
            )
            if pattern
            else None
        )
        registry.append(
            {
                "id": number,
                "reactionPatternId": reaction.reaction_pattern_id,
                "reactionPatternName": pattern.name if pattern else "",
                "reactionRuleId": reaction.reaction_rule_id,
                "reactionRuleName": rule.source_rule.name if rule else "",
                "reactantSmarts": pattern.reactant_smarts if pattern else "",
                "reactionRuleProductSmarts": rule.source_rule.smarts if rule else "",
                "productMoleculeId": reaction.product_molecule_id,
                "sourceAtomMaps": list(reaction.source_atom_maps),
                "retainedAtomMaps": sorted(reaction.retained_atom_maps),
                "discardedAtomMaps": sorted(reaction.discarded_atom_maps),
                "cutBondMaps": sorted(reaction.cut_bond_maps),
                "changedBondMaps": sorted(reaction.changed_bond_maps),
            }
        )
    return registry


@contextlib.contextmanager
def _capture_attention(encoders: dict[str, Any]):
    """Record per-layer, per-head attention probabilities of Graphormer encoders.

    Yields ``{key: [forward, ...]}`` where each forward is a list with one
    ``[batch, heads, tokens, tokens]`` tensor per layer. Weights are requested
    from the existing attention modules, so the model's outputs are unchanged."""
    records: dict[str, list[list[torch.Tensor]]] = {key: [] for key in encoders}
    handles = []

    def need_weights(_module, args, kwargs):
        kwargs["need_weights"] = True
        kwargs["need_head_weights"] = True
        return args, kwargs

    for key, encoder in encoders.items():
        handles.append(
            encoder.register_forward_pre_hook(
                lambda *_args, key=key: records[key].append([])
            )
        )
        if hasattr(encoder, "layers"):
            def request_cross_weights(_module, args, kwargs):
                kwargs["need_weights"] = True
                return args, kwargs
            def save_cross_weights(module, _args, _output, key=key):
                records[key][-1].append(module.last_attention.detach().cpu())
                module.last_attention = None
            for block in encoder.layers:
                handles.append(block.register_forward_pre_hook(request_cross_weights, with_kwargs=True))
                handles.append(block.register_forward_hook(save_cross_weights))
            continue
        for block in encoder.blocks:
            attention = block.mha.self_attn.mha
            assert isinstance(attention, MultiheadAttention)
            handles.append(
                attention.register_forward_pre_hook(need_weights, with_kwargs=True)
            )
            handles.append(
                attention.register_forward_hook(
                    lambda _module, _args, output, key=key: records[key][-1].append(
                        output[1].detach().cpu()
                    )
                )
            )
    try:
        yield records
    finally:
        for handle in handles:
            handle.remove()


@contextlib.contextmanager
def _capture_reaction_transformers(model):
    """Capture final scoring states, excluding transient structural-search states."""
    records = {"encoder": None, "states": []}
    handles = []
    active = False
    state = None
    ids = None

    def begin(_module, args, kwargs):
        nonlocal active, ids
        active = True
        records["states"] = []
        static = kwargs.get("static_features")
        ids = static[3].detach().cpu() if static is not None else None

    def end(*_args):
        nonlocal active
        active = False

    def request(_module, args, kwargs):
        kwargs["need_weights"] = True
        return args, kwargs

    def decoder_request(module, args, kwargs):
        return request(module, args, kwargs) if active else (args, kwargs)

    def encoder_result(_module, _args, output):
        records["encoder"] = [weight.detach().cpu() for weight in output[1]]

    def state_input(_module, args):
        nonlocal state
        if active:
            state = (args[1].detach().cpu(), args[2].detach().cpu())

    def decoder_result(_module, _args, output):
        if not active:
            return
        local, owners = state
        weights = output[1]
        self_weights = [w.detach().cpu() for w in weights.self_attention]
        cross_weights = [w.detach().cpu() for w in weights.cross_attention]
        for row, owner in enumerate(owners.tolist()):
            applied = local[row][local[row] >= 0]
            memory_ids = ids[owner] if ids is not None else torch.arange(_args[1].shape[1])
            valid = memory_ids >= 0
            tokens = ["BOS", "Main adduct", "Root molecule"] + [
                f"Reaction {int(memory_ids[slot])}" for slot in applied
            ]
            query = torch.cat((torch.arange(3), (local[row] >= 0).nonzero().flatten() + 3))
            records["states"].append({
                "tokens": tokens,
                "memoryTokens": [f"Reaction {int(r)}" for r in memory_ids[valid]],
                "appliedReactions": memory_ids[applied].tolist(),
                "self": [_rounded(w[row][:, query][:, :, query]) for w in self_weights],
                "cross": [_rounded(w[row][:, query][:, :, valid.nonzero().flatten()]) for w in cross_weights],
            })

    encoder = model.memory_encoder.encoder
    decoder = model.state_decoder.decoder
    handles.extend([
        model.register_forward_pre_hook(begin, with_kwargs=True),
        model.register_forward_hook(end, always_call=True),
        encoder.register_forward_pre_hook(request, with_kwargs=True),
        encoder.register_forward_hook(encoder_result),
        model.state_decoder.register_forward_pre_hook(state_input),
        decoder.register_forward_pre_hook(decoder_request, with_kwargs=True),
        decoder.register_forward_hook(decoder_result),
    ])
    try:
        yield records
    finally:
        for handle in handles:
            handle.remove()


def _transformer_attention(records, reactions):
    tokens = [f"Reaction {i}" for i in range(len(reactions))]
    encoder = records["encoder"]
    entries = {}
    if encoder and tokens:
        entries["encoder"] = {
            "title": "Reaction memory encoder", "tokens": tokens,
            "keyTokens": tokens, "weights": [_rounded(w[0]) for w in encoder],
        }
    for i, state in enumerate(records["states"]):
        label = ", ".join(map(str, state["appliedReactions"])) or "none"
        for kind in ("self", "cross"):
            entries[f"{kind}-{i}"] = {
                "title": f"State {i} · applied reactions: {label} · {kind}-attention",
                "tokens": state["tokens"],
                "keyTokens": state["tokens"] if kind == "self" else state["memoryTokens"],
                "weights": state[kind],
            }
    for entry in entries.values():
        entry["layers"] = len(entry["weights"])
        entry["heads"] = len(entry["weights"][0])
    return entries


ATTENTION_SCALE = 10000


def _rounded(weights: torch.Tensor) -> list:
    """Compact JSON: probabilities as integers in units of 1/ATTENTION_SCALE."""
    return (weights * ATTENTION_SCALE).round().to(torch.int32).tolist()


def _molecule_layout(compound, graph_atoms) -> dict[str, Any]:
    """2D atom positions and bonds for the atoms represented by the MolEncoder."""
    mol = Chem.Mol(compound.mapped_mol)
    rdDepictor.Compute2DCoords(mol)
    conformer = mol.GetConformer()
    order = {atom.GetIdx(): index for index, atom in enumerate(graph_atoms)}
    atoms = []
    for index, atom in enumerate(graph_atoms):
        position = conformer.GetAtomPosition(atom.GetIdx())
        atoms.append(
            {
                "index": index,
                "symbol": atom.GetSymbol(),
                "mapNumber": atom.GetAtomMapNum(),
                "x": round(position.x, 3),
                "y": round(position.y, 3),
            }
        )
    bonds = [
        [order[bond.GetBeginAtomIdx()], order[bond.GetEndAtomIdx()], bond.GetBondTypeAsDouble()]
        for bond in mol.GetBonds()
        if bond.GetBeginAtomIdx() in order and bond.GetEndAtomIdx() in order
    ]
    return {"atoms": atoms, "bonds": bonds}


def _molecule_attention(generator, compounds: dict[int, Any]) -> dict[str, Any]:
    """MolEncoder self-attention for each fragment-tree Compound.

    Each Compound is re-encoded alone with the graph builder used during
    prediction; the encoder is deterministic in eval mode, so the attention
    equals the one that produced the embeddings used by branch and spectrum."""
    from torch_geometric.data import Batch

    mol_encoder = generator.mol_encoder
    encoder = mol_encoder.encoder
    graph_tokens = int(encoder.graph_token_count)
    nodes = {}
    for node_id, compound in compounds.items():
        graph_atoms = mol_encoder.graph_builder.graph_atoms(compound)
        graph = mol_encoder.encode_components(compound)
        with _capture_attention({"mol": encoder}) as records, torch.no_grad():
            mol_encoder(Batch.from_data_list([graph]))
        size = graph_tokens + len(graph_atoms)
        nodes[str(node_id)] = {
            **_molecule_layout(compound, graph_atoms),
            "weights": [
                _rounded(layer[0, :, :size, :size]) for layer in records["mol"][0]
            ],
        }
    return {
        "layers": int(encoder.num_layers),
        "heads": int(encoder.num_heads),
        "graphTokens": graph_tokens,
        "nodes": nodes,
    }


def _reaction_attention(records, reaction_type, reactions, encoders, source_atoms=()) -> dict[str, Any]:
    """Reactant-to-molecule cross attention from the first reaction encoding pass."""
    result = {}
    for pattern_id, encoder in encoders.items():
        forwards = records.get("reaction:" + pattern_id) or []
        if not forwards:
            continue
        rows = (reaction_type[:, 0] == int(pattern_id)).nonzero().flatten().tolist()
        query = Chem.MolFromSmarts(encoder.reactant_smarts)
        for row_offset, reaction_id in enumerate(rows):
            reaction = reactions[reaction_id]
            maps = list(reaction.source_atom_maps)
            result[str(reaction_id)] = {
                "layers": int(encoder.num_layers),
                "heads": int(encoder.num_heads),
                "graphTokens": 0,
                "keyAtoms": [dict(index=i, symbol=atom.GetSymbol(), mapNumber=atom.GetAtomMapNum())
                             for i, atom in enumerate(source_atoms)],
                "positions": [
                    {
                        "position": position,
                        "smarts": query.GetAtomWithIdx(position).GetSmarts(),
                        "mapNumber": maps[position] if position < len(maps) else 0,
                    }
                    for position in range(encoder.position_count)
                ],
                "weights": [_rounded(layer[row_offset]) for layer in forwards[0]],
            }
    return result


def _merged_intensity(sample_index, formula_tensor, intensity) -> list[float]:
    """Per-candidate intensity of the merged peak sharing its sample and formula.

    Different structures/adducts can yield the same ion formula; they form one
    physical peak whose intensity is the sum of their contributions."""
    keys = [
        (int(sample), tuple(row.tolist()))
        for sample, row in zip(sample_index, formula_tensor)
    ]
    totals: dict[tuple, float] = {}
    for key, value in zip(keys, intensity):
        totals[key] = totals.get(key, 0.0) + float(value)
    return [totals[key] for key in keys]


def _build_tree(
    result, sample: int, tensorizer, threshold: float | None, reactions=()
) -> dict[str, Any]:
    """Fragment-tree nodes/edges explored for this prediction, annotated with
    per-node neutral formula/exact mass plus any predicted-peak ion states."""
    fragments = result.fragments
    core = result.spectrum_batch.canonical_data
    group = int(core.sample_branch_group_index[sample])
    execution = core.execution_graph
    root = int(
        core.source_compounds.compound_index[
            core.reaction_contexts.root_source_compound_index[group]
        ]
    )
    reaction_sets_by_node = {}
    for cid, sid in zip(
        execution.compound_index[execution.branch_group_index == group].tolist(),
        execution.reaction_set_index[execution.branch_group_index == group].tolist(),
    ):
        reaction_sets_by_node.setdefault(cid, []).append(core.reaction_sets.rows()[sid])
    node_offsets = [root] + sorted(set(reaction_sets_by_node) - {root})
    local_index = {cid: cid for cid in node_offsets}
    depth = {cid: min(map(len, sets)) for cid, sets in reaction_sets_by_node.items()}
    edges = []
    first, last = core.reaction_contexts.edge_ptr[group : group + 2]
    graph = core.compound_graph
    for eid in core.reaction_contexts.edge_index[first:last].tolist():
        src, dst, reaction = (
            int(graph.source_compound_index[eid]),
            int(graph.target_compound_index[eid]),
            int(graph.reaction_index[eid]),
        )
        transitions = []
        for before in reaction_sets_by_node.get(src, []):
            after = sorted(before + [reaction])
            if reaction not in before and after in reaction_sets_by_node.get(dst, []):
                transitions.append(
                    dict(
                        addedReaction=reaction,
                        parentReactions=before,
                        targetReactions=after,
                        seed=False,
                    )
                )
        if transitions:
            edges.append(
                dict(
                    id=eid,
                    source=src,
                    target=dst,
                    reactionIndex=reaction,
                    transitions=transitions,
                )
            )

    spectrum_batch = result.spectrum_batch
    spectra = result.spectra
    candidate_node_index = spectrum_batch.state_node_index.detach().cpu().tolist()
    ion_probability = spectra.ion_probability.detach().cpu().tolist()
    candidate_adduct = spectrum_batch.state_adducts
    candidate_sample_index = spectrum_batch.state_sample_index.detach().cpu().tolist()
    candidate_mz = spectrum_batch.state_mz.detach().cpu().tolist()
    candidate_formula_tensor = spectrum_batch.state_formula_tensor
    intensity = spectra.intensity.detach().cpu().tolist()
    merged_intensity = _merged_intensity(
        candidate_sample_index, candidate_formula_tensor, intensity
    )

    # Apply the optional intensity filter to merged peaks, as in the peak table.
    annotations_by_node: dict[int, list[dict[str, Any]]] = {}
    # Each physical candidate row is its own formula.
    for entry, node in enumerate(candidate_node_index):
        if node not in local_index or candidate_sample_index[entry] != sample:
            continue
        probability = float(ion_probability[entry])
        if (
            (threshold is not None and merged_intensity[entry] <= threshold)
            or not bool((candidate_formula_tensor[entry, :-1] >= 0).all())
            or candidate_mz[entry] <= 0
        ):
            continue
        annotations_by_node.setdefault(local_index[node], []).append(
            {
                "peakMz": float(candidate_mz[entry]),
                "peakIntensity": float(intensity[entry]),
                "adduct": (
                    candidate_adduct[entry] if entry < len(candidate_adduct) else ""
                ),
                "ionFormula": str(
                    tensorizer.tensor_to_formula(candidate_formula_tensor[entry])
                ),
                "probability": probability,
            }
        )

    nodes = []
    for global_index in node_offsets:
        compound = fragments.compounds[global_index]
        neutral_formula = compound.formula
        local = local_index[global_index]
        nodes.append(
            {
                "id": local,
                "smiles": compound.smiles,
                "depth": depth[local],
                "precursor": global_index == root,
                "compoundIndex": global_index,
                "formula": str(neutral_formula),
                "exactMass": neutral_formula.exact_mass,
                "annotations": annotations_by_node.get(local, []),
                "reactionSets": reaction_sets_by_node.get(local, []),
            }
        )

    return {"nodes": nodes, "edges": edges}


def list_adducts(request: dict[str, Any]) -> dict[str, Any]:
    """Main adduct types (the measurement-condition adducts) that this
    checkpoint was trained to condition on."""
    model_path = str(request.get("modelPath", "")).strip()
    if not model_path:
        raise ValueError("Model checkpoint path is required.")
    if not Path(model_path).exists():
        raise ValueError(f"Model checkpoint was not found: {model_path}")

    device = torch.device(str(request.get("device") or "cpu"))
    generator = load_generator(
        model_path=model_path, params_path=None, device=device, strict=False
    )
    return {"adducts": list(generator.adduct_type_strs)}


def predict(request: dict[str, Any]) -> dict[str, Any]:
    intensity_threshold = float(request.get("peakIntensityThreshold", 0))
    if not 0 <= intensity_threshold <= 1:
        raise ValueError("Peak intensity threshold must be between 0 and 1.")
    smiles = str(request.get("smiles", "")).strip()
    if not smiles:
        raise ValueError("SMILES is required.")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError("Invalid SMILES.")

    adduct_type = str(request.get("adductType", "")).strip()
    if not adduct_type:
        raise ValueError("Adduct type is required.")
    adduct = Adduct.parse(adduct_type)

    ce = str(request.get("ce", "")).strip()
    if not ce:
        raise ValueError("Collision energy is required.")

    model_path = str(request.get("modelPath", "")).strip()
    if not model_path:
        raise ValueError("Model checkpoint path is required.")
    if not Path(model_path).exists():
        raise ValueError(f"Model checkpoint was not found: {model_path}")

    device = torch.device(str(request.get("device") or "cpu"))

    generator = load_generator(
        model_path=model_path, params_path=None, device=device, strict=False
    )
    source = Compound.from_smiles(smiles)
    neutral_formula = Formula.from_mol(mol).plain
    precursor_mz = adduct.apply_to_mz(neutral_formula.exact_mass)
    ce_ev = parse_ce_to_ev(ce, precursor_mz)
    if ce_ev is None:
        raise ValueError(f"Could not interpret collision energy: {ce!r}")

    reactions = tuple(
        generator.fragmenter.fragment_ion_tree_builder.create_reaction_instances(source)
    )
    reaction_encoder = generator.feature_model.reaction_instance_encoder
    reactant_encoders = dict(reaction_encoder.reactant_encoders.items())
    reaction_inputs: dict[str, torch.Tensor] = {}

    def record_reaction_type(_module, _args, kwargs):
        reaction_inputs.setdefault("reaction_type", kwargs["reaction_type"].detach().cpu())

    capture_reaction_type = reaction_encoder.register_forward_pre_hook(
        record_reaction_type, with_kwargs=True
    )
    with contextlib.ExitStack() as cleanup, _capture_attention(
        {"reaction:" + key: encoder for key, encoder in reactant_encoders.items()}
    ) as reaction_records, _capture_reaction_transformers(
        generator.feature_model
    ) as transformer_records, torch.no_grad():
        cleanup.callback(capture_reaction_type.remove)
        result = generator.predict(
            [source],
            [adduct],
            [ce_ev],
            precomputed={
                source.smiles: {
                    "reactions": reactions,
                    "relations": ReactionRelations.from_reactions(reactions),
                }
            },
        )

    if not result.spectra.mz.numel():
        raise ValueError("The model did not produce any peaks for this input.")
    node_indices = result.spectrum_batch.state_node_index.detach().cpu().tolist()
    node_smiles = result.spectrum_batch.node_smiles
    core = result.spectrum_batch.canonical_data
    root = int(
        core.source_compounds.compound_index[
            core.reaction_contexts.root_source_compound_index[
                core.sample_branch_group_index[0]
            ]
        ]
    )
    ion_adducts = result.spectrum_batch.state_adducts
    # Group physical-ion candidates (structure x adduct) into one peak per
    # ion formula, then apply the user-selected cutoff to the summed peak.
    grouped: dict[tuple, dict[str, Any]] = {}
    for index, (mz, intensity, formula_row, confidence) in enumerate(
        zip(
            result.spectra.mz.detach().cpu().tolist(),
            result.spectra.intensity.detach().cpu().tolist(),
            result.spectra.formula_tensor,
            result.spectra.confidence.detach().cpu().tolist(),
        )
    ):
        if not bool((formula_row[:-1] >= 0).all()) or mz <= 0:
            continue
        node = int(node_indices[index])
        peak = grouped.setdefault(
            tuple(formula_row.tolist()),
            {
                "mz": float(mz),
                "intensity": 0.0,
                "formula": str(generator.tensorizer.tensor_to_formula(formula_row)),
                "confidence": 0.0,
                "precursor": False,
                "contributors": [],
            },
        )
        peak["intensity"] += float(intensity)
        peak["confidence"] = max(peak["confidence"], float(confidence))
        peak["precursor"] = peak["precursor"] or node == root
        peak["contributors"].append(
            {
                "nodeId": node,
                "smiles": node_smiles[node],
                "adduct": ion_adducts[index] if index < len(ion_adducts) else "",
                "intensity": float(intensity),
                "confidence": float(confidence),
                "precursor": node == root,
            }
        )
    peaks = sorted(
        (
            peak
            for peak in grouped.values()
            if intensity_threshold is None or peak["intensity"] > intensity_threshold
        ),
        key=lambda peak: peak["mz"],
    )
    for peak in peaks:
        peak["contributors"].sort(key=lambda row: -row["intensity"])
    if not peaks:
        raise ValueError(
            "Every candidate peak was below the model's inference thresholds."
        )
    tree = _build_tree(
        result,
        sample=0,
        tensorizer=generator.tensorizer,
        threshold=intensity_threshold,
        reactions=reactions,
    )

    attention = {
        "scale": ATTENTION_SCALE,
        "transformers": _transformer_attention(transformer_records, reactions),
        "molecule": _molecule_attention(
            generator,
            {node["id"]: result.fragments.compounds[node["id"]] for node in tree["nodes"]},
        ),
        "reactions": (
            _reaction_attention(
                reaction_records,
                reaction_inputs["reaction_type"],
                reactions,
                reactant_encoders,
                generator.mol_encoder.graph_builder.graph_atoms(source),
            )
            if "reaction_type" in reaction_inputs
            else {}
        ),
    }

    rdDepictor.Compute2DCoords(mol)
    drawer = rdMolDraw2D.MolDraw2DSVG(420, 300)
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText().replace("svg:", "")

    source_drawer = rdMolDraw2D.MolDraw2DSVG(620, 360)
    source_drawer.DrawMolecule(source.mapped_mol)
    source_drawer.FinishDrawing()
    source_svg = source_drawer.GetDrawingText().replace("svg:", "")
    # Drawing coordinates let the viewer overlay a selected reaction's atoms/bonds.
    source_atoms = []
    for atom in source.mapped_mol.GetAtoms():
        point = source_drawer.GetDrawCoords(atom.GetIdx())
        source_atoms.append(
            {"mapNumber": atom.GetAtomMapNum(), "x": round(point.x, 2), "y": round(point.y, 2)}
        )

    return {
        "canonicalSmiles": Chem.MolToSmiles(mol),
        "svg": svg,
        "sourceSvg": source_svg,
        "sourceAtoms": source_atoms,
        "formula": str(neutral_formula),
        "exactMass": neutral_formula.exact_mass,
        "adduct": str(adduct),
        "precursorMz": precursor_mz,
        "peaks": peaks,
        "tree": tree,
        "attention": attention,
        "reactions": _reaction_registry(generator, reactions),
        "reactionPatternSet": (
            generator.fragmenter.fragment_ion_tree_builder.reaction_pattern_set.to_dict()
        ),
    }


COMMANDS = {"predict": predict, "listAdducts": list_adducts}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        command = str(request.get("command", "predict"))
        if command not in COMMANDS:
            raise ValueError(f"Unknown command: {command}")
        # load_generator prints progress lines; redirect them to stderr so
        # stdout stays a single JSON line.
        with contextlib.redirect_stdout(sys.stderr):
            result = COMMANDS[command](request.get("payload", {}))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            )
        )
