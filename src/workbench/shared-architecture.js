// Shared architecture controls mirror the compact CLI and keep detailed edits separate.
const fields = [
  ['hidden_dim', 'Hidden dim', 128, 'Common atom, molecule, reaction, adduct and CE feature width.'],
  ['num_heads', 'Attention heads', 4, 'Common multihead-attention head count; must divide hidden dim.'],
  ['num_layers', 'Base layers', 2, 'Molecular Graphormer, reaction atom cross attention, spectrum GAT and state SetTransformer layers.'],
  ['ffn_mult', 'FFN multiplier', 4, 'Common intermediate-width multiplier for all FFNs.'],
  ['max_degree', 'Maximum degree', 4, 'Molecular and reaction-atom centrality clipping limit.'],
  ['max_spatial_dist', 'Atom distance limit', 4, 'Molecular and reaction-atom shortest-path encoding limit.'],
  ['max_edge_dist', 'Bond path limit', 4, 'Molecular and reaction-atom bond-path encoding limit.'],
  ['reaction_encoder_layers', 'Reaction encoder layers', 2, 'Reaction-memory Transformer encoder depth.'],
  ['reaction_decoder_layers', 'Reaction decoder layers', 2, 'Applied-reaction-set Transformer decoder depth.'],
  ['reaction_instance_max_distance', 'Reaction-instance distance limit', 4, 'Minimum source-molecule bond distance between the matched atom sets of two reactions. Overlap is zero; farther or disconnected pairs use the overflow bucket.'],
  ['fc_layers', 'FC hidden layers', 3, 'Number of symmetric hidden widths in CE, Fragment Head and State Head. Zero selects a direct Linear readout.'],
  ['fc_mult', 'FC multiplier', 2, 'Symmetric FC width multiplier. Three layers give H, H × multiplier, H.'],
];
const defaults = Object.fromEntries(fields.map(([key, , value]) => [key, value]));

function trainingArchitectureMode(config) {
  if (config.architectureMode !== undefined) {
    if (!['shared', 'detailed'].includes(config.architectureMode)) throw new Error('Select Shared or Detailed architecture settings.');
    return config.architectureMode;
  }
  // Older documents contain explicit component settings; preserve them verbatim.
  return config.modelConfig ? 'detailed' : 'shared';
}

function sharedArchitectureError(value) {
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < (key === 'fc_layers' ? 0 : 1)) return 'Use positive integers for shared architecture settings (FC hidden layers may be zero).';
  }
  if (value.hidden_dim % value.num_heads) return 'Hidden dim must be divisible by attention heads.';
  const exponent = Math.max(0, Math.floor((value.fc_layers - 1) / 2));
  if (!Number.isSafeInteger(value.hidden_dim * value.fc_mult ** exponent)) return 'The generated FC widths are too large.';
  return '';
}

function sharedFcWidths(value) {
  return Array.from({length: value.fc_layers}, (_, i) => value.hidden_dim * value.fc_mult ** Math.min(i, value.fc_layers - 1 - i));
}

function expandSharedArchitecture(config, sharedDefaults) {
  if (trainingArchitectureMode(config) !== 'shared') return config;
  const value = {...sharedDefaults, ...config.sharedArchitecture};
  config.sharedArchitecture = value;
  config.architectureMode = 'shared';
  // Resume consumes the checkpoint architecture regardless of the visible interface.
  if (config.trainingMode === 'resume' || !config.trainingMode && config.resume) return config;
  const model = config.modelConfig ??= {};
  const mol = model.mol_encoder_params ??= {};
  Object.assign(mol, {
    node_dim: value.hidden_dim, graph_dim: value.hidden_dim, num_heads: value.num_heads,
    num_layers: value.num_layers, ffn_mult: value.ffn_mult, max_degree: value.max_degree,
    max_spatial_dist: value.max_spatial_dist, max_edge_dist: value.max_edge_dist,
  });
  const reaction = model.reaction_model_params ??= {};
  Object.assign(reaction, {hidden_dim: value.hidden_dim, branch_main_adduct_dim: value.hidden_dim, num_heads: value.num_heads});
  reaction.reaction_transformer = {
    encoder_layers: value.reaction_encoder_layers, decoder_layers: value.reaction_decoder_layers,
    num_heads: value.num_heads, ffn_mult: value.ffn_mult, max_reaction_distance: value.reaction_instance_max_distance,
  };
  const frozen = new Set((config.patternArchitecture?.frozenPatternIds || []).map(String));
  for (const [pid, pattern] of Object.entries(reaction.pattern_model_params || {})) {
    if (frozen.has(pid)) continue;
    for (const key of ['hidden_dim', 'num_heads', 'num_layers', 'ffn_mult', 'max_degree', 'max_spatial_dist', 'max_edge_dist']) pattern[key] = value[key];
  }
  const spectrum = model.spectrum_model_params ??= {};
  Object.assign(spectrum, {
    gat_num_layers: value.num_layers, state_set_num_layers: value.num_layers, state_set_num_heads: value.num_heads,
    gat_ffn_mult: value.ffn_mult, state_set_ffn_mult: value.ffn_mult,
    adduct_embedding_dim: value.hidden_dim, collision_energy_dim: value.hidden_dim,
  });
  if (!sharedArchitectureError(value)) {
    for (const name of ['ce', 'fragment', 'state']) spectrum[name + '_fc_dims'] = sharedFcWidths(value);
  }
  return config;
}

function sharedImportError(value, model) {
  if (!model) return '';
  const expected = {node_dim: value.hidden_dim, graph_dim: value.hidden_dim, num_heads: value.num_heads,
    num_layers: value.num_layers, ffn_mult: value.ffn_mult, max_degree: value.max_degree,
    max_spatial_dist: value.max_spatial_dist, max_edge_dist: value.max_edge_dist};
  const fallback = {ffn_mult: 4, max_degree: 4, max_spatial_dist: 3, max_edge_dist: 3};
  if (Object.entries(expected).some(([key, number]) => (model.mol_encoder_params?.[key] ?? fallback[key]) !== number)
      || (model.reaction_model_params?.hidden_dim ?? 128) !== value.hidden_dim) {
    return 'Imported molecular settings and reaction output width must match the shared settings. Match these values or choose Detailed.';
  }
  return '';
}

function html() {
  return `<label>Architecture settings<select id="trainingArchitectureMode" name="architectureMode"><option value="shared">Shared settings (default)</option><option value="detailed">Detailed settings</option></select></label>
<p id="trainingArchitectureStatus" role="status"></p>
<div id="trainingSharedArchitecture"><p class="muted">Set common dimensions, attention heads, base layers and FFN widths. Reaction Transformer depths remain separate. Each reaction pattern keeps its own weights.</p>
<div class="grid">${fields.map(([key, label, value, help]) => `<label><span data-help="${help}">${label}</span><input type="number" min="${key === 'fc_layers' ? 0 : 1}" step="1" value="${value}" data-shared-architecture-parameter="${key}" data-tuning-key="sharedArchitecture.${key}"></label>`).join('')}</div>
<p id="trainingFcWidths" role="status"></p><p class="muted">The reaction memory GNN stays one hop; the spectrum GAT stays single-head. FC counts describe hidden layers before the output Linear.</p></div>`;
}

function client() {
  const form = document.getElementById('trainingForm');
  const select = document.getElementById('trainingArchitectureMode');
  const panel = document.getElementById('trainingSharedArchitecture');
  const status = document.getElementById('trainingArchitectureStatus');
  const preview = document.getElementById('trainingFcWidths');
  let mode = trainingArchitectureMode(initialTraining);
  let value = {...sharedArchitectureDefaults, ...initialTraining.sharedArchitecture};
  let detailedInitialized = mode === 'detailed';
  let imported = null;
  const original = getTrainingConfig;
  getTrainingConfig = () => {
    const config = original();
    config.trainingMode = form.querySelector('[name=trainingMode]:checked')?.value || 'new';
    config.architectureMode = mode;
    config.sharedArchitecture = {...value};
    return expandSharedArchitecture(config, sharedArchitectureDefaults);
  };
  function sync(render = false) {
    const resume = form.querySelector('[name=trainingMode]:checked')?.value === 'resume';
    select.value = mode;
    select.disabled = resume;
    panel.hidden = mode !== 'shared';
    form.dataset.architectureMode = mode;
    const error = sharedArchitectureError(value) || sharedImportError(value, imported);
    form.dataset.sharedArchitectureValid = mode !== 'shared' || resume || !error ? 'true' : 'false';
    status.textContent = resume ? 'Architecture is restored from the checkpoint and locked.' : mode === 'shared'
      ? error || 'Shared settings expand into the ordinary detailed training arguments.'
      : 'Edit each model component and reaction pattern independently.';
    preview.textContent = sharedArchitectureError(value) ? 'Enter valid shared settings to preview FC widths.'
      : 'CE / Fragment Head / State Head hidden widths: ' + (value.fc_layers ? sharedFcWidths(value).join(', ') : 'none (direct Linear)');
    for (const input of panel.querySelectorAll('[data-shared-architecture-parameter]')) {
      input.disabled = resume;
      if (render) input.value = value[input.dataset.sharedArchitectureParameter];
    }
    if (render) window.dispatchEvent(new CustomEvent('training/architectureMode', {detail: mode}));
  }
  select.onchange = () => {
    if (select.value === 'detailed' && !detailedInitialized) {
      const config = getTrainingConfig();
      if (imported) {
        config.modelConfig.mol_encoder_params = JSON.parse(JSON.stringify(imported.mol_encoder_params));
        config.modelConfig.reaction_model_params.hidden_dim = imported.reaction_model_params?.hidden_dim ?? 128;
      }
      window.dispatchEvent(new CustomEvent('training/detailedArchitecture', {detail: config}));
      detailedInitialized = true;
    }
    mode = select.value;
    sync(true);
    form.dispatchEvent(new Event('input', {bubbles: true}));
  };
  for (const input of panel.querySelectorAll('[data-shared-architecture-parameter]')) {
    input.oninput = () => {
      value[input.dataset.sharedArchitectureParameter] = input.value.trim() ? Number(input.value) : NaN;
      sync();
    };
  }
  form.addEventListener('change', event => {if (event.target.name === 'trainingMode') sync(true);});
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'trainingConfig') {
      mode = trainingArchitectureMode(message.config);
      value = {...sharedArchitectureDefaults, ...message.config.sharedArchitecture};
      detailedInitialized = mode === 'detailed';
      imported = null;
      sync(true);
    }
    if (message.type === 'architecture/loaded' && form.querySelector('[name=trainingMode]:checked')?.value !== 'resume') {
      mode = 'detailed';
      detailedInitialized = true;
      sync(true);
    }
    if (message.type === 'training/importedFeatures') {imported = message.modelConfig; sync();}
    if (message.type === 'training/sources' && message.requestId === form.dataset.sourcesRequest && !message.error) {
      imported = message.modelConfig?.fine_tuning?.frozen_pattern_ids?.length ? message.modelConfig : null;
      sync();
    }
  });
  // Re-render the effective shared editor before the training client validates inputs.
  sync(true);
}

module.exports = {
  fields, defaults, trainingArchitectureMode, sharedArchitectureError, sharedFcWidths,
  expandSharedArchitecture, sharedImportError, html,
  helpers: () => `const sharedArchitectureDefaults=${JSON.stringify(defaults)};${trainingArchitectureMode.toString()}${sharedArchitectureError.toString()}${sharedFcWidths.toString()}${expandSharedArchitecture.toString()}${sharedImportError.toString()}`,
  script: () => `(${client.toString()})();`,
};
