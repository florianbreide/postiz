import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Rule 2: no post and no reply without a person. The inbox demo (PR 26)
// writes to the platform only on a call through the backend route. Nothing in
// the orchestrator (workflows, activities, schedules) may import it or call
// reply, hide or remove of an inbox provider. This test reads the sources.

const ROOT = join(__dirname, '..', '..', '..', '..');
const ORCHESTRATOR = join(ROOT, 'apps', 'orchestrator', 'src');
const YSOCIAL_LIBRARY = join(ROOT, 'libraries', 'ysocial', 'src');
const YSOCIAL_BACKEND = join(ROOT, 'apps', 'backend', 'src', 'ysocial');

const SKIPPED_DIRECTORIES = ['node_modules', 'dist', '.next'];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.includes(name) ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !name.endsWith('.spec.ts') ? [path] : [];
  });

const read = (file: string) => readFileSync(file, 'utf8');
const rel = (file: string) => file.slice(ROOT.length + 1);

describe('inbox demo and automation (rule 2)', () => {
  const orchestratorFiles = sourceFiles(ORCHESTRATOR);

  it('finds the orchestrator sources', () => {
    expect(
      orchestratorFiles.some((file) => file.endsWith('ysocial.emit.ts'))
    ).toBe(true);
  });

  it.each(orchestratorFiles.map((file) => [rel(file), file]))(
    '%s does not import the inbox',
    (_name, file) => {
      const source = read(file);
      expect(source).not.toMatch(/inbox\//i);
      expect(source).not.toMatch(/ysocial\.inbox/i);
      expect(source).not.toMatch(/YsocialInbox|InstagramInbox|InboxProvider/);
    }
  );

  it('has no inbox write call in a workflow or activity file', () => {
    const risky = orchestratorFiles.filter((file) =>
      /(workflow|activit)/i.test(file)
    );
    expect(risky.length).toBeGreaterThan(0);
    for (const file of risky) {
      const source = read(file);
      expect(source).not.toMatch(/\.(reply|hide|remove)\(/);
    }
  });

  it('is imported by no other library file than the service and the dto', () => {
    const importers = sourceFiles(YSOCIAL_LIBRARY)
      .filter((file) => !file.includes(`${join('src', 'inbox')}`))
      .filter((file) => /inbox\//.test(read(file)))
      .map((file) => rel(file));
    expect(importers.sort()).toEqual(
      ['libraries/ysocial/src/dtos/ysocial.inbox.dto.ts'].sort()
    );
  });

  it('has YsocialInboxService called only by the inbox controller', () => {
    const users = [
      ...sourceFiles(YSOCIAL_BACKEND),
      ...sourceFiles(ORCHESTRATOR),
    ]
      .concat(sourceFiles(YSOCIAL_LIBRARY))
      .filter((file) => !/ysocial\.inbox\.service\.ts$/.test(file))
      .filter((file) => /import[^;]*YsocialInboxService/.test(read(file)))
      .map((file) => rel(file))
      .sort();
    // The module only registers it as a provider.
    expect(users).toEqual([
      'apps/backend/src/ysocial/ysocial.inbox.controller.ts',
      'apps/backend/src/ysocial/ysocial.module.ts',
    ]);

    const controller = read(
      join(YSOCIAL_BACKEND, 'ysocial.inbox.controller.ts')
    );
    expect(controller).toMatch(
      /_inboxService\.(getComments|reply|hide|remove)/
    );

    const module = read(join(YSOCIAL_BACKEND, 'ysocial.module.ts'));
    expect(module).not.toMatch(/_?inboxService\./);
  });

  it('calls reply, hide and remove of the service only in the controller', () => {
    const callers = sourceFiles(join(ROOT, 'apps'))
      .concat(sourceFiles(join(ROOT, 'libraries')))
      .filter((file) => /inboxService\.(reply|hide|remove)\(/.test(read(file)))
      .map((file) => rel(file));
    expect(callers).toEqual([
      'apps/backend/src/ysocial/ysocial.inbox.controller.ts',
    ]);
  });

  // Tripwire: whoever imports the inbox provider or service anywhere in
  // apps/*/src or libraries/*/src (a new workflow, activity, controller or
  // library) has to be added here on purpose, with a review.
  describe('importers of the inbox', () => {
    const ALLOWED = [
      'libraries/ysocial/src/inbox/ysocial.inbox.service.ts',
      'apps/backend/src/ysocial/ysocial.inbox.controller.ts',
      'apps/backend/src/ysocial/ysocial.module.ts',
      'libraries/ysocial/src/dtos/ysocial.inbox.dto.ts',
      'apps/backend/src/ysocial/ysocial.inbox.demo.guard.ts',
    ];
    const IMPORT = /(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g;
    const INBOX_SPECIFIER =
      /(^|\/)inbox\/|instagram\.inbox|ysocial\.inbox\.service/;

    const roots = ['apps', 'libraries'].flatMap((top) =>
      readdirSync(join(ROOT, top))
        .map((name) => join(ROOT, top, name, 'src'))
        .filter((dir) => {
          try {
            return statSync(dir).isDirectory();
          } catch {
            return false;
          }
        })
    );
    const files = roots.flatMap(sourceFiles);

    it('scans the source folders of apps and libraries', () => {
      expect(roots.map(rel)).toEqual(
        expect.arrayContaining([
          'apps/backend/src',
          'apps/orchestrator/src',
          'libraries/ysocial/src',
        ])
      );
      expect(files.length).toBeGreaterThan(100);
      expect(
        files.every(
          (file) =>
            !/node_modules|\/dist\//.test(file) && !/\.spec\.ts$/.test(file)
        )
      ).toBe(true);
    });

    it('is imported only by the allowed files', () => {
      const importers = files
        .filter((file) => {
          const source = read(file);
          return [...source.matchAll(IMPORT)].some((match) =>
            INBOX_SPECIFIER.test(match[1])
          );
        })
        .map(rel)
        .sort();
      expect(importers).toEqual([...ALLOWED].sort());
    });
  });
});
