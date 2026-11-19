import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const paths = [...files('src'), ...files('test'), ...files('scripts'), 'vitest.config.ts'];
let errors = 0;
for (const path of paths.filter((path) => /\.(ts|mjs)$/.test(path))) {
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function fail(node, rule) {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    console.error(`${path}:${line + 1}:${character + 1}: ${rule}`);
    errors++;
  }
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) fail(node, 'Use a concrete type, not any');
    if (ts.isDebuggerStatement(node)) fail(node, 'Remove debugger statements');
    if (ts.isNonNullExpression(node)) fail(node, 'Narrow nullable types, do not assert them');
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) fail(node, 'Narrow types, do not cast them');
    if (ts.isCatchClause(node) && node.block.statements.length === 0) fail(node, 'Do not swallow errors in an empty catch');
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (/^\s*(?:\/\/|\/\*|\*)\s*(?:@ts-(?:ignore|nocheck)|eslint-disable)/m.test(source)) {
    console.error(`${path}: lint/type suppression is forbidden`);
    errors++;
  }
  if (path.endsWith('.mjs')) {
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (check.status !== 0) { console.error(check.stderr); errors++; }
  }
}
if (errors) process.exit(1);
console.log(`Lint passed: ${paths.filter((path) => /\.(ts|mjs)$/.test(path)).length} source, test and tool files`);
