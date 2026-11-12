import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// The token extension decrypts and encrypts in the Prisma client. Raw SQL,
// the fluent relation API and a second PrismaClient go around it (spike
// PR 25). Postiz uses none of them today. This test reads the sources of
// Postiz and fails once a change brings one in, with file and line.

const ROOT = join(__dirname, '..', '..', '..', '..');

const sourceRoots = () => [
  join(ROOT, 'apps', 'backend', 'src'),
  join(ROOT, 'apps', 'orchestrator', 'src'),
  join(ROOT, 'apps', 'commands', 'src'),
  ...readdirSync(join(ROOT, 'libraries')).map((name) =>
    join(ROOT, 'libraries', name, 'src')
  ),
];

const sourceFiles = (dir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
};

// Comments are blanked, line breaks stay, so line numbers still match.
const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_all, before) => before);

const PRISMA_SERVICE = join(
  'libraries',
  'nestjs-libraries',
  'src',
  'database',
  'prisma',
  'prisma.service.ts'
);

// Names of the fields that point to Integration, read from schema.prisma.
// The fluent API returns the stored ciphertext through any of them.
const integrationRelationNames = () => {
  const source = readFileSync(
    join(
      ROOT,
      'libraries',
      'nestjs-libraries',
      'src',
      'database',
      'prisma',
      'schema.prisma'
    ),
    'utf8'
  );
  const names = new Set<string>();
  for (const [, , body] of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const line of body.split('\n')) {
      const match = line.trim().match(/^(\w+)\s+Integration(\[\])?(\?)?(\s|$)/);
      if (match) {
        names.add(match[1]);
      }
    }
  }
  return [...names].sort();
};

const FORBIDDEN: Array<{ name: string; pattern: RegExp; allowIn?: string }> = [
  { name: '$queryRaw', pattern: /\$queryRaw\b/ },
  { name: '$executeRaw', pattern: /\$executeRaw\b/ },
  { name: '$queryRawUnsafe', pattern: /\$queryRawUnsafe\b/ },
  { name: '$executeRawUnsafe', pattern: /\$executeRawUnsafe\b/ },
  { name: '$runCommandRaw', pattern: /\$runCommandRaw\b/ },
  { name: 'Prisma.sql', pattern: /\bPrisma\s*\.\s*sql\b/ },
  { name: 'Prisma.raw', pattern: /\bPrisma\s*\.\s*raw\b/ },
  {
    name: 'fluent call on the Integration relation',
    pattern: new RegExp(
      `\\)\\s*\\.\\s*(?:${integrationRelationNames().join('|')})\\s*\\(`
    ),
  },
  {
    name: 'new PrismaClient(',
    pattern: /\bnew\s+PrismaClient\s*\(/,
    allowIn: PRISMA_SERVICE,
  },
  { name: '$use(', pattern: /\.\s*\$use\s*\(/ },
  { name: '$queryRawTyped', pattern: /\$queryRawTyped\b/ },
  // undefined on the extended client
  { name: '$on(', pattern: /\.\s*\$on\s*\(/ },
  // throws on the proxies of the result extension
  { name: 'structuredClone(', pattern: /\bstructuredClone\s*\(/ },
];

// Matches over the whole text, so a call chain over several lines is found.
// Returns "<name> at line <n>" per hit.
const scanSource = (source: string, path: string) => {
  const text = withoutComments(source);
  return FORBIDDEN.flatMap(({ name, pattern, allowIn }) => {
    if (allowIn === path) {
      return [];
    }
    const global = new RegExp(pattern.source, 'g');
    return Array.from(text.matchAll(global), (match) => ({
      name,
      line: text.slice(0, match.index).split('\n').length,
    }));
  });
};

const findings = (files: string[]) =>
  files.flatMap((file) => {
    const path = relative(ROOT, file);
    return scanSource(readFileSync(file, 'utf8'), path).map(
      ({ name, line }) => `${path}:${line} uses ${name}`
    );
  });

describe('token encryption bypass', () => {
  const files = sourceRoots().flatMap(sourceFiles);

  it('finds the Postiz sources', () => {
    const paths = files.map((file) => relative(ROOT, file));
    expect(files.length).toBeGreaterThan(100);
    expect(paths).toContain(PRISMA_SERVICE);
    expect(
      paths.some((p) => p.startsWith(join('apps', 'backend', 'src')))
    ).toBe(true);
    expect(
      paths.some((p) => p.startsWith(join('apps', 'orchestrator', 'src')))
    ).toBe(true);
    expect(
      paths.some((p) => p.startsWith(join('apps', 'commands', 'src')))
    ).toBe(true);
    expect(paths.some((p) => p.endsWith('integration.repository.ts'))).toBe(
      true
    );
    expect(paths.some((p) => p.endsWith('.spec.ts'))).toBe(false);
    expect(paths.some((p) => p.startsWith(join('apps', 'frontend')))).toBe(
      false
    );
  });

  it('has no raw query, fluent relation call, second client or $use', () => {
    expect(findings(files)).toEqual([]);
  });

  describe('relations to Integration', () => {
    it('are read from schema.prisma', () => {
      expect(integrationRelationNames()).toEqual(
        expect.arrayContaining(['Integration', 'integrations', 'integration'])
      );
    });
  });

  describe('the scan itself', () => {
    const scan = (source: string) =>
      scanSource(source, 'x.ts').map(({ name }) => name);

    it.each([
      ['this.p.$queryRaw`select 1`', '$queryRaw'],
      ['await db.$executeRaw(sql)', '$executeRaw'],
      ['db.$queryRawUnsafe(q)', '$queryRawUnsafe'],
      ['db.$executeRawUnsafe(q)', '$executeRawUnsafe'],
      ['db.$runCommandRaw({})', '$runCommandRaw'],
      ['Prisma.sql`x`', 'Prisma.sql'],
      ['Prisma.raw(x)', 'Prisma.raw'],
      [
        'this.m.post.findUnique({ where }).integration()',
        'fluent call on the Integration relation',
      ],
      [
        'x.findUnique({ where })\n  .integrations()',
        'fluent call on the Integration relation',
      ],
      [
        'a.findFirst().Integration()',
        'fluent call on the Integration relation',
      ],
      ['const c = new PrismaClient()', 'new PrismaClient('],
      ['client.$use(async () => {})', '$use('],
      ['db.$queryRawTyped(q)', '$queryRawTyped'],
      ["prisma.$on('query', log)", '$on('],
      ['const copy = structuredClone(row)', 'structuredClone('],
      [
        'x.findFirst()\n  .Integration()',
        'fluent call on the Integration relation',
      ],
    ])('flags %j', (source, name) => {
      expect(scan(source)).toContain(name);
    });

    it('ignores comments and ordinary code', () => {
      expect(
        scan(
          [
            '// db.$queryRaw`x`',
            '/* Prisma.sql',
            '   new PrismaClient() */',
            'const url = "https://a.b"; this.model.integration.findMany({})',
            'class P extends PrismaClient {}',
          ].join('\n')
        )
      ).toEqual([]);
    });

    it('reports a line number', () => {
      expect(scanSource('a\n/* x\ny */\nb.$queryRaw`1`', 'x.ts')).toEqual([
        { name: '$queryRaw', line: 4 },
      ]);
    });

    it('allows new PrismaClient( only in prisma.service.ts', () => {
      const source = 'const c = new PrismaClient();';
      expect(scanSource(source, PRISMA_SERVICE)).toEqual([]);
      expect(scanSource(source, 'other.ts')).toHaveLength(1);
    });
  });

  describe('prisma.service.ts', () => {
    const source = readFileSync(join(ROOT, PRISMA_SERVICE), 'utf8');

    it('returns the extended client from the constructor', () => {
      expect(withoutComments(source)).toMatch(
        /return\s+withYsocialTokenEncryption\s*\(\s*this\s*\)\s*;/
      );
    });

    it('carries the ysocial patch 3 comment', () => {
      expect(source).toContain('ysocial patch 3');
    });
  });
});
