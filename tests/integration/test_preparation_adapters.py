"""Real dataset inspection and train/validation preparation regressions."""

from fredis.ml.input.adduct_data import AdductData
import contextlib
import importlib.util
import io
import json
import torch
import tempfile
import unittest
import unittest.mock
from pathlib import Path
import numpy as np
import pandas as pd
from fredis.data import MSDataset
from fredis.data.core.PeakSeries import PeakSeries
from fredis.libs.mmkit.mmkit import Compound, Adduct
from fredis.ml.data_preparation.fragment_tree.datasets import (
    load_spectrum_dataset,
    split_by_smiles,
)
from fredis.ml.data_preparation.fragment_tree.create_training_data import (
    main,
    _confirm_existing_output,
)
from fredis.ml.data_preparation.fragment_tree.context import create_preparation_context
from fredis.ml.data_preparation.fragment_tree.record_validation import inspect_records
from .reaction_config import chemistry, config

spec = importlib.util.spec_from_file_location(
    "workbench_dataset_backend",
    Path("src/workbench/dataset_backend.py"),
)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class TestPreparationAdapters(unittest.TestCase):
    def dataset(self):
        smiles = ["CCO", "CCO", "CCN", "CCC", "COC"]
        mzs = [
            Compound.from_smiles(value).formula.exact_mass + 1.007276466
            for value in smiles
        ]
        metadata = pd.DataFrame(
            {
                "SMILES": smiles,
                "AdductType": ["[M+H]+"] * 5,
                "CollisionEnergy": [20] * 5,
                "PrecursorMZ": mzs,
            }
        )
        peaks = np.array([[mz, 1] for mz in mzs], dtype=float)
        return MSDataset(metadata, PeakSeries(peaks, np.arange(6, dtype=np.int64)))

    def test_preview_and_column_validation_use_actual_data(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "dataset.msds"
            self.dataset().save(str(file))
            preview = backend.preview({"path": str(file), "limit": 2})
            self.assertFalse(preview["valuesChecked"])
            self.assertEqual(preview["validation"]["smilesColumn"]["valid"], 0)
            checked = backend.preview(
                {
                    "path": str(file),
                    "validateValues": True,
                    "fragmenterParams": chemistry()["fragmenter_params"],
                }
            )
            self.assertTrue(checked["valuesChecked"])
            self.assertEqual(checked["validation"]["smilesColumn"]["valid"], 5)
            self.assertEqual(preview["records"], 5)
            self.assertEqual(preview["summary"]["uniqueSmiles"], 4)
            self.assertEqual(len(preview["rows"]), 2)
            self.assertEqual(preview["size"], file.stat().st_size)
            self.assertFalse(preview["errors"])
            invalid = backend.preview(
                {"path": str(file), "mapping": {"smilesColumn": "missing"}}
            )
            self.assertFalse(invalid["validation"]["smilesColumn"]["exists"])
            self.assertTrue(invalid["errors"])

    def test_invalid_metadata_is_inspectable_and_excluded_from_preparation(self):
        data = self.dataset()
        metadata = pd.DataFrame(
            {
                "SMILES": ["CCO", "invalid", "CCN", "CCC", "COC"],
                "AdductType": ["[M+H]+", "[M+H]+", "invalid", "[M+H]+", "[M+H]+"],
                "CollisionEnergy": ["20", "20", "20", "invalid", "20"],
                "PrecursorMZ": ["100", "100", "100", "100", "invalid"],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / "invalid.msds"
            MSDataset(metadata, data.peaks).save(str(file))
            result = backend.preview(
                {
                    "path": str(file),
                    "validateValues": True,
                    "fragmenterParams": chemistry()["fragmenter_params"],
                }
            )
            self.assertFalse(result["errors"])
            self.assertEqual(result["eligibleRecords"], 1)
            self.assertEqual(result["excludedRecords"], 4)
            self.assertEqual(result["invalidRecordCount"], 4)
            self.assertEqual(
                [row["index"] for row in result["invalidRecords"]], [1, 2, 3, 4]
            )
            self.assertEqual(
                result["invalidRecords"][1]["values"]["adductTypeColumn"], "invalid"
            )
            self.assertIn(
                "main adduct", result["invalidRecords"][1]["issues"][0]["reason"]
            )
            progress = []
            limited = inspect_records(
                MSDataset(metadata, data.peaks),
                create_preparation_context(chemistry()).fragmenter,
                progress=lambda current, total: progress.append((current, total)),
                invalid_detail_limit=2,
            )
            self.assertEqual(limited["excludedRecords"], 4)
            self.assertEqual(len(limited["invalidRecords"]), 2)
            self.assertEqual(progress[0], (0, 5))
            self.assertEqual(progress[-1], (5, 5))
            from fredis.ml.data_preparation.fragment_tree.create_training_data import (
                create_reaction_training_data,
            )

            model = chemistry()
            model["fragmenter_params"]["fragment_ion_tree_builder"][
                "max_reaction_count"
            ] = 1
            with contextlib.redirect_stdout(io.StringIO()):
                files = create_reaction_training_data(
                    dataset=MSDataset(metadata, data.peaks),
                    chemistry_config=model,
                    output_dir=root / "direct",
                )
                main(
                    [
                        "--input",
                        str(file),
                        "--output-dir",
                        str(root / "cli"),
                        "--params-json",
                        json.dumps(model),
                    ]
                )
            self.assertEqual(len(files), 1)
            self.assertEqual(
                len(json.loads((root / "direct/invalid_records.json").read_text())), 4
            )
            self.assertEqual(
                len(
                    json.loads((root / "cli/invalid_records.json").read_text())["train"]
                ),
                4,
            )
            self.assertEqual(len(list((root / "cli").rglob("*.preft.pt"))), 1)
            saved = json.loads((root / "cli/fragment-tree.training-data-config.pft").read_text())
            self.assertEqual((root / "cli" / saved["input"]).resolve(), file.resolve())
            self.assertEqual(saved["max_unique_fragment_smiles"], -1)
            self.assertEqual(saved["max_reaction_combinations"], -1)

    def test_result_inspection_preserves_reaction_states_and_reaction_references(self):
        from fredis.libs.mmkit.mmkit import Formula
        from fredis.ml.data_preparation.fragment_tree.create_training_data import (
            create_reaction_training_data,
        )

        result_spec = importlib.util.spec_from_file_location(
            "result_backend",
            "src/features/fragment-tree-result/backend.py",
        )
        result_backend = importlib.util.module_from_spec(result_spec)
        result_spec.loader.exec_module(result_backend)
        peaks = np.array(
            [
                [Formula.parse(value).exact_mass, 10.0 if value == "C2H7O+" else 1.0]
                for value in ["C2H7O+", "CH5O+", "H3O+", "C2H7+"]
            ]
            + [[1000.0, 2.0]]
        )
        data = MSDataset(
            pd.DataFrame(
                {
                    "SMILES": ["CCO"],
                    "AdductType": ["[M+H]+"],
                    "CollisionEnergy": [20.25],
                    "PrecursorMZ": [47],
                }
            ),
            PeakSeries(peaks, np.array([0, 5], dtype=np.int64)),
        )
        model = chemistry()
        model["fragmenter_params"]["fragment_ion_tree_builder"][
            "max_reaction_count"
        ] = 1
        with (
            tempfile.TemporaryDirectory() as directory,
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            files = create_reaction_training_data(
                dataset=data, chemistry_config=model, output_dir=directory
            )
            result = result_backend.inspect_structure(files[0])
            scores = pd.read_csv(Path(directory) / "assignment_scores.tsv", sep="\t")
            self.assertEqual(len(scores), 1)
            manifest = pd.read_csv(Path(directory) / "manifest.tsv", sep="\t").iloc[0]
            self.assertEqual(manifest.num_nodes, 5)
            self.assertEqual(manifest.num_edges, 4)
            self.assertEqual(manifest.rejected_sample_count, 0)
            self.assertAlmostEqual(manifest.assignment_score, 13 / 15)
            self.assertAlmostEqual(manifest.assignment_score_without_precursor, 3 / 5)
            recovered = backend.structure_manifest({"directory": directory})[0]
            self.assertEqual(recovered["num_nodes"], 5)
            self.assertEqual(recovered["num_edges"], 4)
            self.assertAlmostEqual(recovered["assignment_score"], 13 / 15)
            self.assertAlmostEqual(scores.assignment_score.iloc[0], 13 / 15)
            self.assertAlmostEqual(
                scores.assignment_score_without_precursor.iloc[0], 3 / 5
            )
        sample = result["samples"][0]
        self.assertEqual(sample["nodeCount"], 5)
        self.assertEqual(sample["adduct"], "[M+H]+")
        self.assertEqual(sample["mainAdduct"], "[M+H]+")
        self.assertEqual(sample["collisionEnergyDisplay"], "20.3")
        self.assertEqual(len(sample["peaks"]), 5)
        self.assertEqual(sample["peaks"][-1]["matches"], [])
        self.assertTrue(sample["peaks"][0]["precursor"])
        self.assertAlmostEqual(sample["assignmentScore"], 13 / 15)
        self.assertAlmostEqual(sample["assignmentScoreWithoutPrecursor"], 3 / 5)
        self.assertTrue(
            all(
                "hydrogenShift" in match and match["nodeIds"]
                for peak in sample["peaks"][:-1]
                for match in peak["matches"]
            )
        )
        self.assertEqual(
            len({node["id"] for node in sample["nodes"]}), sample["nodeCount"]
        )
        self.assertGreater(sample["edgeCount"], 0)
        self.assertTrue(
            next(node for node in sample["nodes"] if node["id"] == 0)["precursor"]
        )
        self.assertEqual(result["summary"]["nodes"], sample["nodeCount"])
        self.assertEqual(
            result["summary"]["edgeTransitions"], sample["edgeTransitionCount"]
        )
        self.assertTrue(
            all(isinstance(node["reactionSets"], list) for node in sample["nodes"])
        )
        registry = {reaction["id"] for reaction in result["reactions"]}
        self.assertTrue(
            all(
                transition["addedReaction"] in registry
                for edge in sample["edges"]
                for transition in edge["transitions"]
            )
        )
        self.assertTrue(
            all(reaction["sourceAtomMaps"] for reaction in result["reactions"])
        )
        from fredis.domain.fragment.fragmenter import Fragmenter

        patterns = {
            pattern.pattern_id: pattern
            for pattern in Fragmenter.from_dict(
                model["fragmenter_params"]
            ).fragment_ion_tree_builder.reaction_pattern_set
        }
        for reaction in result["reactions"]:
            pattern = patterns[reaction["reactionPatternId"]]
            rule = next(
                rule
                for rule in pattern.reaction_rules
                if rule.id == reaction["reactionRuleId"]
            )
            self.assertEqual(reaction["reactionPatternName"], pattern.name)
            self.assertEqual(reaction["reactantSmarts"], pattern.reactant_smarts)
            self.assertEqual(reaction["reactionRuleName"], rule.source_rule.name)
            self.assertEqual(
                reaction["reactionRuleProductSmarts"], rule.source_rule.smarts
            )
            self.assertLess(reaction["productMoleculeId"], len(rule.prod_temp))
        self.assertIn("<svg", result["sourceSvg"])

    def test_preflight_rejects_leaking_validation_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "dataset.msds"
            self.dataset().save(str(file))
            with self.assertRaisesRegex(ValueError, "share SMILES"):
                backend.validate(
                    {
                        **{
                            "fragmenterParams": chemistry()["fragmenter_params"],
                            "symbols": chemistry()["symbols"],
                        },
                        "input": str(file),
                        "validationInput": str(file),
                    }
                )

    def test_explicit_validation_uses_main_adduct_and_metadata_parsers(self):
        data = self.dataset()
        # Construct actual metadata with parsable strings, an unsupported main adduct,
        # a neutral loss that resolves to registered [M+H]+, and invalid values.
        metadata = pd.DataFrame(
            {
                "SMILES": ["CCO", "CCO", "CCN", "CCC", "invalid"],
                "AdductType": ["[M+H-H2O]+", "[M+K]+", "invalid", "[M+H]+", "[M+H]+"],
                "CollisionEnergy": ["20 eV", "30%", "invalid", "nan", "40"],
                "PrecursorMZ": ["100.1", "200", "invalid", "300", "inf"],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "data.msds"
            MSDataset(metadata, data.peaks).save(str(file))
            result = backend.preview(
                {
                    "path": str(file),
                    "validateValues": True,
                    "fragmenterParams": chemistry()["fragmenter_params"],
                }
            )
            self.assertEqual(result["validation"]["smilesColumn"]["valid"], 4)
            self.assertEqual(result["validation"]["adductTypeColumn"]["valid"], 3)
            self.assertEqual(result["validation"]["collisionEnergyColumn"]["valid"], 3)
            self.assertEqual(result["validation"]["precursorMzColumn"]["valid"], 3)
            self.assertEqual(result["excludedRecords"], 4)
            self.assertEqual(len(result["invalidRecords"][1]["issues"]), 3)
            self.assertFalse(result["errors"])

    def test_preflight_accepts_fragmenter_and_symbols_without_a_model(self):
        model = chemistry()
        result = backend.validate(
            {
                "fragmenterParams": model["fragmenter_params"],
                "symbols": model["symbols"],
                "maxUniqueFragmentSmiles": 20,
                "maxReactionCombinations": 40,
            }
        )
        self.assertTrue(result["valid"])
        with self.assertRaisesRegex(ValueError, "Max unique fragment SMILES"):
            backend.validate(
                {
                    "fragmenterParams": model["fragmenter_params"],
                    "symbols": ["C"],
                    "maxUniqueFragmentSmiles": 0,
                }
            )
        with self.assertRaisesRegex(ValueError, "Max reaction combinations"):
            backend.validate(
                {
                    "fragmenterParams": model["fragmenter_params"],
                    "symbols": ["C"],
                    "maxReactionCombinations": 0,
                }
            )

    def test_cli_and_workbench_share_limit_names_and_saved_settings(self):
        import shutil, subprocess
        from fredis.ml.data_preparation.fragment_tree.create_training_data import (
            build_arg_parser,
        )

        node = shutil.which("node")
        if node is None:
            self.skipTest("node is required to load the Workbench extension module")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_file = root / "train.msds"
            self.dataset().save(str(input_file))
            model = chemistry()
            model["fragmenter_params"]["fragment_ion_tree_builder"][
                "max_reaction_count"
            ] = 1
            with (
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                main(
                    [
                        "--input",
                        str(input_file),
                        "--output-dir",
                        str(root / "out"),
                        "--params-json",
                        json.dumps(model),
                        "--max-unique-fragment-smiles",
                        "30",
                        "--max-reaction-combinations",
                        "400",
                        "--overwrite",
                        "1",
                    ]
                )
            saved = json.loads((root / "out/fragment-tree.training-data-config.pft").read_text())
            script = """
const Module=require('module'),load=Module._load;
Module._load=function(name,...rest){return name==='vscode'?{window:{},Uri:{file:fsPath=>({fsPath})}}:load.call(this,name,...rest);};
const {normalizeConfig,buildArgs}=require(process.argv[1]);
const saved=JSON.parse(require('fs').readFileSync(0,'utf8'));
const config=normalizeConfig(saved);
process.stdout.write(JSON.stringify({config,args:buildArgs(config)}));
"""
            extension = str(Path("src/extension.js").resolve())
            completed = subprocess.run(
                [node, "-e", script, extension],
                input=json.dumps(saved),
                capture_output=True,
                text=True,
                check=True,
            )
            result = json.loads(completed.stdout)
        config_ = result["config"]
        self.assertEqual(
            (config_["maxUniqueFragmentSmiles"], config_["maxReactionCombinations"]),
            (30, 400),
        )
        # The Workbench command line is accepted by the CLI parser with the same values.
        args = build_arg_parser().parse_args(
            result["args"][result["args"].index("create-fragment-tree-data") + 1 :]
        )
        self.assertEqual(
            (args.max_unique_fragment_smiles, args.max_reaction_combinations), (30, 400)
        )

