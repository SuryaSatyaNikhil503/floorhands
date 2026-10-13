import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('runs on Node 22+', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
});

test('package is an ES module with no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.name, 'floorhands');
});
