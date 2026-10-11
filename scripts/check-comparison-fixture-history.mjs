import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAppendOnlyFixturePins, assertRetainsComparisonFixturePins } from './comparison-fixtures.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseSha = process.env.COMPARISON_BASE_SHA;
if (!/^[0-9a-f]{40}$/i.test(baseSha ?? '')) throw new Error('COMPARISON_BASE_SHA must identify a full base commit SHA');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

try {
  git(['cat-file', '-e', `${baseSha}^{commit}`]);
} catch (error) {
  throw new Error(`Cannot resolve comparison history base commit ${baseSha}`, { cause: error });
}

const registry = JSON.parse(await readFile(join(root, 'config/databases.json'), 'utf8'));
const history = JSON.parse(await readFile(join(root, 'config/comparison-fixtures-history.json'), 'utf8'));
if (history.format !== 'demodb-comparison-fixture-history/v1') throw new Error('Unsupported current comparison fixture history format');
assertAppendOnlyFixturePins(registry.comparisonFixtures ?? [], history.fixtures);

const baseRegistry = JSON.parse(git(['show', `${baseSha}:config/databases.json`]));
const baseHistoryPath = 'config/comparison-fixtures-history.json';
const baseTreePaths = git(['ls-tree', '-r', '--name-only', baseSha, '--', baseHistoryPath]).trim().split('\n').filter(Boolean);
let priorPins;
if (baseTreePaths.includes(baseHistoryPath)) {
  const baseHistory = JSON.parse(git(['show', `${baseSha}:${baseHistoryPath}`]));
  if (baseHistory.format !== 'demodb-comparison-fixture-history/v1') throw new Error('Unsupported base comparison fixture history format');
  assertAppendOnlyFixturePins(baseRegistry.comparisonFixtures ?? [], baseHistory.fixtures);
  priorPins = baseHistory.fixtures;
} else {
  // Before the ledger was introduced, the base registry is the authoritative set of published paths.
  priorPins = baseRegistry.comparisonFixtures ?? [];
}

assertRetainsComparisonFixturePins(registry.comparisonFixtures ?? [], priorPins);
console.log(`Comparison fixture history preserves ${priorPins.length} base pin(s) from ${baseSha}`);
