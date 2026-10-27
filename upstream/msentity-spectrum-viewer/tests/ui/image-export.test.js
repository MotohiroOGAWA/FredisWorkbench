const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../ui/spectrum.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  const exportRange ='), source.indexOf('  const comparison =')) + '\nthis.range = exportRange; this.labels = labelPeaks;', context);
test('export ranges use auto endpoints and reject reversed or invalid ranges', () => {
  assert.deepEqual(Array.from(context.range('', 200, [10, 100])), [10, 200]);
  assert.deepEqual(Array.from(context.range(20, '', [10, 100])), [20, 100]);
  for (const range of [[100, 20], [20, 20], [-1, 20], ['bad', 20]]) {
    assert.throws(() => context.range(...range, [0, 100]));
  }
});
test('top K ranks eligible peaks separately and keeps stable ties', () => {
  const peaks = [{y: 20, index: 0}, {y: 50, index: 1}, {y: 50, index: 2}, {y: 100, index: 3}];
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 1}), p => p.index), [1]);
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 0}), p => p.index), [0, 1, 2]);
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 10}), p => p.index), [1, 2, 0]);
  assert.equal(peaks[0].index, 0);
});
