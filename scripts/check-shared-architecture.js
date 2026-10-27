// Exercise the actual Workbench DOM, command builder and Python argument expansion.
const assert = require('assert/strict');
const path = require('path');
const {spawnSync} = require('child_process');
const {JSDOM, VirtualConsole} = require('jsdom');
const Module = require('module'), load = Module._load;
Module._load = function(name, ...args) {return name === 'vscode' ? {} : load.call(this, name, ...args);};
const ext = require('../src/extension');
const shared = require('../src/workbench/shared-architecture');
const {plan} = require('../src/workbench/tuning');
const fixture = require('./fixtures');

async function main() {
  const messages = [], errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.detail?.stack || error.message));
  const dom = new JSDOM(ext.workbenchHtml(fixture.dataConfig, {
    datasetDir: 'prepared', outputDir: 'run', epochs: 1, batchSize: 1, lr: 0.001,
  }), {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({postMessage: message => messages.push(message), getState: () => ({}), setState() {}});
      window.HTMLElement.prototype.scrollIntoView = function() {};
      window.ResizeObserver = class {observe() {} disconnect() {}};
      window.matchMedia = () => ({matches: false, addEventListener() {}});
      window.CSS = {escape: value => value};
    },
  });
  try {
    const w = dom.window, d = w.document, form = d.getElementById('trainingForm');
    const snapshot = () => JSON.parse(JSON.stringify(w.eval('getTrainingConfig()')));
    const post = data => w.dispatchEvent(new w.MessageEvent('message', {data}));
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const mode = value => {const select = d.getElementById('trainingArchitectureMode'); select.value = value; select.dispatchEvent(new w.Event('change', {bubbles: true}));};
    const input = (key, value) => {const element = form.querySelector(`[data-shared-architecture-parameter="${key}"]`); element.value = String(value); element.dispatchEvent(new w.Event('input', {bubbles: true}));};
    assert.deepEqual(errors, []);
    assert.equal(d.getElementById('trainingArchitectureMode').value, 'shared');
    assert.equal(d.getElementById('trainingSharedArchitecture').hidden, false);
    assert.equal(form.querySelector('[data-parameter-path="mol_encoder_params.node_dim"]'), null);
    assert.equal(ext.buildTrainingArgs(snapshot())[3], 'fragment-tree');
    assert.equal(snapshot().trainingMode, 'new');
    assert(form.querySelector('[data-parameter-path="spectrum_model_params.ce_scale"]'));
    for (const [key, value] of Object.entries({hidden_dim: 256, num_heads: 8, num_layers: 3, ffn_mult: 2, fc_layers: 3, fc_mult: 2})) input(key, value);
    let config = snapshot();
    assert.equal(config.modelConfig.mol_encoder_params.node_dim, 256);
    assert.equal(config.modelConfig.mol_encoder_params.graph_dim, 256);
    assert.equal(config.modelConfig.reaction_model_params.reaction_transformer.ffn_mult, 2);
    assert.deepEqual(config.modelConfig.spectrum_model_params.fragment_fc_dims, [256, 512, 256]);
    assert.match(d.getElementById('trainingFcWidths').textContent, /256, 512, 256/);
    const compact = ext.buildTrainingArgs(config);
    assert(!compact.includes('--model-architecture-json'));
    assert(!compact.includes('--node-dim'));
    assert(!compact.some(value => value.startsWith('--pattern-')));
    assert.equal(compact[compact.indexOf('--hidden-dim') + 1], '256');
    const source = messages.filter(message => message.type === 'training/sources').at(-1);
    post({type: 'training/sources', requestId: source.requestId,
      modelConfig: {...config.modelConfig, fragmenter_params: fixture.chemistry.fragmenter_params,
        adduct_type_strs: fixture.model.adduct_type_strs}, patternModels: []});
    post({type: 'workbench/environment', data: {cuda: true}});
    await settle();
    assert.equal(d.getElementById('trainingStart').disabled, false,
      d.getElementById('trainingPreflight').textContent);

    mode('detailed');
    let detailedInput = form.querySelector('[data-parameter-path="mol_encoder_params.node_dim"]');
    assert(detailedInput);
    assert.equal(detailedInput.value, '256');
    detailedInput.value = '32'; detailedInput.dispatchEvent(new w.Event('input', {bubbles: true}));
    const detailed = snapshot();
    assert.equal(detailed.modelConfig.mol_encoder_params.node_dim, 32);
    assert.equal(ext.buildTrainingArgs(detailed)[3], 'fragment-tree-detailed');
    mode('shared');
    assert.equal(snapshot().modelConfig.mol_encoder_params.node_dim, 256);
    mode('detailed');
    assert.equal(form.querySelector('[data-parameter-path="mol_encoder_params.node_dim"]').value, '32');
    // Configuration and architecture-document loading preserve the intended interface.
    post({type: 'trainingConfig', config: detailed}); await settle();
    assert.equal(d.getElementById('trainingArchitectureMode').value, 'detailed');
    post({type: 'trainingConfig', config}); await settle();
    assert.equal(d.getElementById('trainingArchitectureMode').value, 'shared');
    assert.equal(snapshot().sharedArchitecture.hidden_dim, 256);
    const loaded = ext.normalizeTrainingConfig({...config, trainingMode: 'new', resume: './last.pt'});
    post({type: 'trainingConfig', config: loaded}); await settle();
    assert.equal(snapshot().modelConfig.mol_encoder_params.node_dim, 256);
    assert.equal(snapshot().resume, '');
    assert.equal(ext.normalizeTrainingConfig({modelConfig: fixture.model}).architectureMode, 'detailed');
    post({type: 'architecture/loaded', value: {mol_encoder_params: {...fixture.model.mol_encoder_params}}}); await settle();
    assert.equal(d.getElementById('trainingArchitectureMode').value, 'detailed');
    assert.equal(snapshot().modelConfig.mol_encoder_params.node_dim, 32);
    mode('shared');

    input('num_heads', 7);
    assert.equal(form.dataset.sharedArchitectureValid, 'false');
    assert.throws(() => ext.buildTrainingArgs(snapshot()), /divisible/);
    input('num_heads', 8);
    input('fc_layers', 0);
    assert.deepEqual(snapshot().modelConfig.spectrum_model_params.ce_fc_dims, []);
    input('fc_layers', 5);
    assert.deepEqual(snapshot().modelConfig.spectrum_model_params.state_fc_dims, [256, 512, 1024, 512, 256]);
    input('fc_layers', 3);

    // Tuning searches shared values and sends compact trials to the Python CLI.
    const tuning = {...snapshot(), tuning: {enabled: true, parameters: {'sharedArchitecture.hidden_dim': [128, 256], 'sharedArchitecture.fc_layers': [0, 3]}}};
    const trials = plan(tuning, ext.buildTrainingArgs);
    assert.equal(trials.length, 4);
    assert(trials.every(trial => trial.args[3] === 'fragment-tree'));
    assert.deepEqual(trials[0].config.modelConfig.spectrum_model_params.ce_fc_dims, []);
    assert.throws(() => plan({...tuning, tuning: {parameters: {'modelConfig.mol_encoder_params.node_dim': [32]}}}, ext.buildTrainingArgs), /shared architecture parameters/);
    assert.throws(() => plan({...tuning, patternArchitecture: {frozenPatternIds: ['0']}}, ext.buildTrainingArgs), /inherited and cannot be tuned/);
    d.getElementById('trainingTuningToggle').click(); await settle();
    const hidden = form.querySelector('[data-shared-architecture-parameter="hidden_dim"]');
    const control = hidden.parentElement.querySelector('.tuning-control');
    assert(control && !control.hidden);
    const [check, values] = control.querySelectorAll('input');
    values.value = '128,256'; check.checked = true; check.dispatchEvent(new w.Event('change', {bubbles: true}));
    assert.deepEqual(snapshot().tuning.parameters['sharedArchitecture.hidden_dim'], [128, 256]);
    mode('detailed'); await settle();
    assert(!('sharedArchitecture.hidden_dim' in snapshot().tuning.parameters));
    mode('shared');

    // Incompatible imported dimensions require matching shared values or Detailed.
    post({type: 'training/importedFeatures', modelConfig: fixture.model});
    assert.equal(form.dataset.sharedArchitectureValid, 'false');
    assert.match(d.getElementById('trainingArchitectureStatus').textContent, /choose Detailed/);
    mode('detailed');
    assert.equal(form.dataset.sharedArchitectureValid, 'true');
    post({type: 'trainingConfig', config}); await settle();
    assert.equal(form.dataset.sharedArchitectureValid, 'true');

    const resume = form.querySelector('[name=trainingMode][value=resume]');
    resume.checked = true; resume.dispatchEvent(new w.Event('change', {bubbles: true}));
    assert.equal(d.getElementById('trainingArchitectureMode').disabled, true);
    assert([...d.querySelectorAll('[data-shared-architecture-parameter]')].every(element => element.disabled));
    const resumeArgs = ext.buildTrainingArgs(snapshot());
    assert(resumeArgs.includes('--resume'));
    assert(!resumeArgs.includes('--hidden-dim'));

    // Check the real argument parsers, including the common-to-detailed expansion.
    const result = spawnSync('python', ['-c', `
import json, sys
from fredis.ml.training.fragment_tree_training import shared_training, training
compact, detailed = json.load(sys.stdin)
args = shared_training.build_arg_parser().parse_args(compact[4:])
config = training.training_model_config(shared_training.detailed_namespace(args))
assert config['mol_encoder_params']['node_dim'] == config['mol_encoder_params']['graph_dim'] == 256
assert config['spectrum_model_params']['ce_fc_dims'] == [256,512,256]
assert config['reaction_model_params']['reaction_transformer']['ffn_mult'] == 2
args = training.build_arg_parser().parse_args(detailed[4:])
assert args.node_dim == 32
`], {cwd: require('./paths').applicationRoot, input: JSON.stringify([compact, ext.buildTrainingArgs(detailed)]), encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(errors, []);
  } finally {await new Promise(resolve => setImmediate(resolve)); dom.window.close();}
  process.stdout.write('Shared/default and detailed architecture switching, preservation, reload, validation, resume, tuning and Python CLI checks passed.\n');
}
main().catch(error => {process.stderr.write(error.stack + '\n'); process.exitCode = 1;});
