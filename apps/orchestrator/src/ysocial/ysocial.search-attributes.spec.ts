import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Postiz terminates every workflow with a matching postId search attribute
// when a post is changed or deleted. ysocial workflows therefore never set a
// search attribute at all (PLAN E13, R6). This test reads every ysocial
// source file of the orchestrator and the shared library.

const ROOTS = [
  __dirname,
  join(__dirname, '..', '..', '..', '..', 'libraries', 'ysocial', 'src'),
];

const FORBIDDEN = [
  /searchAttributes/i,
  /upsertSearchAttributes/,
  /upsertTypedSearchAttributes/,
  /defineSearchAttributeKey/,
  /temporal\.search\.attribute/,
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });

describe('ysocial and Temporal search attributes', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('finds the ysocial sources', () => {
    expect(files.some((file) => file.endsWith('ysocial.emit.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('hub.event.ts'))).toBe(true);
  });

  it.each(
    files.map((file) => [
      file.split('/apps/').pop()?.split('/libraries/').pop(),
      file,
    ])
  )('%s sets no search attribute', (_name, file) => {
    const source = readFileSync(file as string, 'utf8');
    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });
});
