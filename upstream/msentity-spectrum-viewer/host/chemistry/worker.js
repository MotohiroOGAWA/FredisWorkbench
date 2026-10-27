"use strict";

// Worker thread running RDKit (WebAssembly build, @rdkit/rdkit). Requests
// {id, type, ...params} arrive as messages; each is answered with
// {id, ok: true, result} or {id, ok: false, error}. The first message posted
// is {type: "capabilities", chemistry}.

const { parentPort } = require("worker_threads");

const NONE = { backend: null, smarts_filter: false, structure_render: false, structure_count: false };

let RDKit = null;
const smoke = { smiles_parse: false, smarts_parse: false, substructure_match: false, svg_drawing: false, canonical_smiles: false };

function capabilities() {
  if (!RDKit) return NONE;
  return {
    backend: "rdkit",
    smarts_filter: smoke.smiles_parse && smoke.smarts_parse && smoke.substructure_match,
    structure_render: smoke.smiles_parse && smoke.svg_drawing,
    structure_count: smoke.smiles_parse && smoke.canonical_smiles,
  };
}

/** Run `use(mol)` on a molecule parsed from SMILES and release it; null when invalid. */
function withMolecule(smiles, use) {
  if (!smiles) return null;
  let mol = null;
  try {
    mol = RDKit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return null;
    return use(mol);
  } catch {
    return null;
  } finally {
    mol?.delete();
  }
}

const normalize = (value) => (value == null ? "" : String(value).trim());

function smartsMatch({ values = [], pattern = "" }) {
  if (!capabilities().smarts_filter) throw new Error("SMARTS filtering requires optional RDKit support");
  let query = null;
  try {
    query = RDKit.get_qmol(String(pattern));
  } catch {
    query = null;
  }
  if (!query || !query.is_valid()) {
    query?.delete();
    throw new Error("Invalid SMARTS pattern");
  }
  try {
    const cache = new Map();   // SMILES → match; each distinct structure is parsed once
    return values.map((value) => {
      const smiles = normalize(value);
      if (!cache.has(smiles)) {
        cache.set(smiles, withMolecule(smiles, (mol) => mol.get_substruct_match(query) !== "{}") === true);
      }
      return cache.get(smiles);
    });
  } finally {
    query.delete();
  }
}

function structureCounts({ values = [] }) {
  if (!capabilities().structure_count) throw new Error("Structure counting requires optional RDKit support");
  const unique = new Set(values.map(normalize).filter(Boolean));
  const canonical = new Set();
  for (const smiles of unique) {
    const result = withMolecule(smiles, (mol) => mol.get_smiles());
    if (result) canonical.add(result);
  }
  return { unique_smiles: unique.size, canonical_structures: canonical.size };
}

function render({ smiles, width = 560, height = 400 }) {
  if (!capabilities().structure_render) throw new Error("Structure rendering requires optional RDKit support");
  const text = normalize(smiles);
  const clamp = (value, fallback) => Math.min(1200, Math.max(200, Number(value) || fallback));
  const svg = withMolecule(text, (mol) => mol.get_svg(clamp(width, 560), clamp(height, 400)));
  if (!svg) throw new Error("Invalid SMILES");
  return { smiles: text, svg };
}

const handlers = { "smarts-match": smartsMatch, "structure-counts": structureCounts, render, capabilities };

async function start() {
  if (process.env.MSENTITY_SPECTRUM_VIEWER_DISABLE_RDKIT !== "1") {
    try {
      RDKit = await require("@rdkit/rdkit")();
      // Enable only the features whose smoke tests pass.
      const mol = RDKit.get_mol("CCO");
      const query = RDKit.get_qmol("C");
      smoke.smiles_parse = Boolean(mol && mol.is_valid());
      smoke.smarts_parse = Boolean(query && query.is_valid());
      if (smoke.smiles_parse && smoke.smarts_parse) smoke.substructure_match = mol.get_substruct_match(query) !== "{}";
      if (smoke.smiles_parse) {
        smoke.canonical_smiles = mol.get_smiles() === "CCO";
        smoke.svg_drawing = mol.get_svg(120, 90).includes("<svg");
      }
      mol?.delete();
      query?.delete();
    } catch (error) {
      RDKit = null;
      parentPort.postMessage({ type: "log", message: `RDKit unavailable: ${error.message}` });
    }
  }
  parentPort.postMessage({ type: "capabilities", chemistry: capabilities(), version: RDKit ? RDKit.version() : null });
  parentPort.on("message", (request) => {
    try {
      const handler = handlers[request.type];
      if (!handler) throw new Error(`Unknown chemistry request: ${request.type}`);
      parentPort.postMessage({ id: request.id, ok: true, result: handler(request) });
    } catch (error) {
      parentPort.postMessage({ id: request.id, ok: false, error: error.message || String(error) });
    }
  });
}

start();
