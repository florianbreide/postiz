// Tests for ysocial-upstream-check.mjs. No network: the GitHub API is a fake,
// release data comes from ysocial-upstream-check.fixtures.json (invented).
//
// Run from the repo root with Node 22:
//   node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs
// Jest (libraries/ysocial/jest.config.js) only runs *.spec.ts and skips this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ISSUE_AUTHOR,
  UPSTREAM,
  buildIssueBody,
  compareVersions,
  formatDate,
  issueTitle,
  newerReleases,
  parseBaseVersion,
  run,
  securityHits,
  syncBranch,
} from './ysocial-upstream-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const fixtures = JSON.parse(
  await readFile(join(HERE, 'ysocial-upstream-check.fixtures.json'), 'utf8')
);
const ALL = [...fixtures.synthetic, ...fixtures.upstream_wording];
const release = (tag) => {
  const found = ALL.find((r) => r.tag_name === tag);
  assert.ok(found, `fixture ${tag} missing`);
  return found;
};

const PATCHES_V2251 = [
  '# YSOCIAL-PATCHES',
  '',
  '- Fork: `example-org/postiz`, Original: `gitroomhq/postiz-app` (Remote `upstream`)',
  '- Basis: upstream v2.25.1 (11.10.2026)',
  '',
  'Monatlich ein PR `upstream-sync/<yyyy-mm>`.',
].join('\n');

const NOW = new Date('2026-10-19T06:00:00Z');
const CONTEXT = { repo: { owner: 'example-org', repo: 'postiz' } };
// Author of issues the workflow creates with GITHUB_TOKEN.
const BOT = { login: 'github-actions[bot]', type: 'Bot' };

function fakeCore() {
  const logs = [];
  return {
    logs,
    info: (m) => logs.push(['info', m]),
    notice: (m) => logs.push(['notice', m]),
  };
}

// Minimal stand-in for the Octokit client that github-script provides.
function fakeGithub({
  latest,
  releases = [],
  issues = [],
  labels = [],
  pageSize = 100,
}) {
  const store = [...issues];
  const calls = {
    latest: 0,
    listReleases: 0,
    pages: 0,
    getLabel: 0,
    createLabel: [],
    create: [],
  };
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

  const github = {
    rest: {
      repos: {
        getLatestRelease: async (params) => {
          assert.deepEqual(params, UPSTREAM);
          calls.latest++;
          return { data: latest };
        },
        listReleases: async (params) => {
          assert.equal(params.owner, UPSTREAM.owner);
          assert.equal(params.repo, UPSTREAM.repo);
          calls.listReleases++;
          return { data: releases };
        },
      },
      issues: {
        listForRepo: async () => {
          throw new Error('listForRepo must go through github.paginate');
        },
        getLabel: async (params) => {
          assert.equal(params.owner, CONTEXT.repo.owner);
          calls.getLabel++;
          if (!labels.includes(params.name)) throw notFound();
          return { data: { name: params.name } };
        },
        createLabel: async (params) => {
          calls.createLabel.push(params);
          labels.push(params.name);
          return { data: params };
        },
        create: async (params) => {
          calls.create.push(params);
          const issue = {
            number: 100 + calls.create.length,
            title: params.title,
            state: 'open',
            user: BOT,
          };
          store.unshift(issue);
          return { data: issue };
        },
      },
    },
    // Same contract as octokit.paginate(route, params, mapFn).
    paginate: async (route, params, mapFn) => {
      assert.equal(route, github.rest.issues.listForRepo);
      assert.equal(params.state, 'all');
      assert.equal(params.owner, CONTEXT.repo.owner);
      assert.equal(params.repo, CONTEXT.repo.repo);
      const out = [];
      let stopped = false;
      for (let i = 0; i < store.length && !stopped; i += pageSize) {
        calls.pages++;
        const response = { data: store.slice(i, i + pageSize) };
        out.push(...mapFn(response, () => (stopped = true)));
      }
      return out;
    },
  };
  return { github, calls, store, labels };
}

async function withPatchesFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ysocial-upstream-check-'));
  try {
    const path = join(dir, 'YSOCIAL-PATCHES.md');
    await writeFile(path, content);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- base version -----------------------------------------------------------

test('reads the base version from the real YSOCIAL-PATCHES.md', async () => {
  const text = await readFile(join(REPO_ROOT, 'YSOCIAL-PATCHES.md'), 'utf8');
  assert.match(parseBaseVersion(text), /^v\d+\.\d+\.\d+$/);
});

test('parses the base line in several spellings', () => {
  const cases = [
    ['- Basis: upstream v2.25.1 (11.10.2026)', 'v2.25.1'],
    ['- **Basis:** upstream `v2.25.1` (11.10.2026)', 'v2.25.1'],
    ['* Basis: Upstream 2.26.0 (01.11.2026)', 'v2.26.0'],
    ['Basis : UPSTREAM   v2.30.12', 'v2.30.12'],
    ['- Basis: v2.27.0 (02.12.2026)', 'v2.27.0'],
    ['- Basis: upstream v3.0.0-rc.2', 'v3.0.0-rc.2'],
    ['# X\r\n\r\n- Basis: upstream v2.25.1 (11.10.2026)\r\n', 'v2.25.1'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseBaseVersion(input), expected, input);
  }
});

test('never takes the date for the version', () => {
  assert.throws(
    () => parseBaseVersion('- Basis: upstream (11.10.2026)'),
    /Basis-Version nicht gefunden/
  );
});

test('the fork ROADMAP.md names the same base as YSOCIAL-PATCHES.md', async () => {
  const patches = await readFile(join(REPO_ROOT, 'YSOCIAL-PATCHES.md'), 'utf8');
  const roadmap = await readFile(join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
  assert.equal(parseBaseVersion(roadmap), parseBaseVersion(patches));
});

test('only Basis lines count, never other "upstream vX.Y.Z" in the file', () => {
  assert.throws(
    () => parseBaseVersion('Stand des Forks: upstream v2.25.1, siehe unten.'),
    /Basis-Version nicht gefunden/
  );
  // A Basis line without a version fails, even with a version elsewhere.
  assert.throws(
    () =>
      parseBaseVersion(
        '- Basis: upstream (11.10.2026)\n\nSync auf upstream v2.26.0 geplant.'
      ),
    /Basis-Version nicht gefunden/
  );
  assert.equal(
    parseBaseVersion(
      '- Basis: upstream v2.25.1 (11.10.2026)\n\nSync auf upstream v2.26.0 geplant.'
    ),
    'v2.25.1'
  );
});

test('fails on missing or conflicting base versions', () => {
  assert.throws(() => parseBaseVersion(''), /nicht gefunden/);
  assert.throws(
    () =>
      parseBaseVersion('- Basis: upstream v2.25.1\n- Basis: upstream v2.26.0'),
    /nicht eindeutig: v2\.25\.1, v2\.26\.0/
  );
  assert.equal(
    parseBaseVersion('- Basis: upstream v2.25.1\n- Basis: upstream 2.25.1'),
    'v2.25.1'
  );
});

// --- versions ---------------------------------------------------------------

test('compares versions numerically, prereleases below releases', () => {
  assert.equal(compareVersions('v2.25.10', 'v2.25.9'), 1);
  assert.equal(compareVersions('v2.26.0', 'v2.25.1'), 1);
  assert.equal(compareVersions('v3.0.0', 'v2.99.99'), 1);
  assert.equal(compareVersions('v2.25.1', '2.25.1'), 0);
  assert.equal(compareVersions('v2.25.0', 'v2.25.1'), -1);
  assert.equal(compareVersions('v2.27.0-rc.1', 'v2.27.0'), -1);
  assert.equal(compareVersions('v2.27.0-rc.2', 'v2.27.0-rc.10'), -1);
  assert.equal(compareVersions('v2.27.0-alpha', 'v2.27.0-rc.1'), -1);
  assert.throws(() => compareVersions('latest', 'v2.25.1'), /nicht lesbar/);
});

// --- security detection -----------------------------------------------------

const NONE = { strong: [], weak: [] };

test('upstream security notices are strong signals', () => {
  assert.deepEqual(securityHits(release('v2.25.1')), {
    strong: ['upgrade immediately', 'PSA'],
    weak: ['security', 'vulnerability'],
  });
  assert.deepEqual(securityHits(release('v2.24.0')).strong, [
    'upgrade immediately',
    'PSA',
  ]);
  assert.deepEqual(securityHits(release('v2.21.6')).strong, [
    'upgrade immediately',
    'GHSA',
  ]);
  assert.deepEqual(securityHits(release('v2.25.0')), NONE);
  assert.deepEqual(securityHits(release('v2.22.1')), NONE);
});

test('a bare mention of security is only a weak signal', () => {
  // A "## Security" section without advisory or "upgrade immediately".
  assert.deepEqual(securityHits(release('v2.23.0')), {
    strong: [],
    weak: ['security'],
  });
  // Only a new contact address for security reports.
  assert.deepEqual(securityHits(release('v2.20.0')), {
    strong: [],
    weak: ['security', 'vulnerability'],
  });
  assert.deepEqual(securityHits({ name: 'Sicherheitsupdate', body: '' }), {
    strong: [],
    weak: ['Sicherheit'],
  });
});

test('CVE counts only with a number', () => {
  assert.deepEqual(securityHits(release('v2.25.2')), {
    strong: ['CVE'],
    weak: [],
  });
  assert.deepEqual(
    securityHits({ name: 'x', body: 'docs: how we name CVE reports' }),
    NONE
  );
  assert.deepEqual(securityHits({ name: 'v2.26.0', body: null }), NONE);
});

// --- release selection --------------------------------------------------------

test('lists stable releases between base and latest, newest first', () => {
  const newer = newerReleases(ALL, 'v2.25.1', release('v2.26.0'));
  assert.deepEqual(
    newer.map((r) => r.tag_name),
    ['v2.26.0', 'v2.25.2']
  );
});

test('keeps latest even when the list call missed it', () => {
  const newer = newerReleases([], 'v2.25.1', release('v2.26.0'));
  assert.deepEqual(
    newer.map((r) => r.tag_name),
    ['v2.26.0']
  );
});

// --- issue text ---------------------------------------------------------------

test('dates and branch names use Europe/Berlin', () => {
  assert.equal(formatDate('2026-10-11T15:19:10Z'), '11.10.2026');
  assert.equal(formatDate('2026-10-14T22:30:00Z'), '15.10.2026');
  assert.equal(
    syncBranch(new Date('2026-10-31T23:30:00Z'), false),
    'upstream-sync/2026-11'
  );
  assert.equal(syncBranch(NOW, true), 'upstream-sync/2026-10-security');
});

test('issue body for a regular release', () => {
  const latest = release('v2.26.0');
  const { body, security } = buildIssueBody({
    latest,
    base: 'v2.25.1',
    newer: [latest],
    now: NOW,
  });
  assert.equal(security, false);
  assert.equal(issueTitle('v2.26.0'), 'Postiz v2.26.0 verfügbar');
  assert.ok(body.includes(`[v2.26.0](${latest.html_url})`));
  assert.ok(body.includes('Veröffentlicht: 19.10.2026'));
  assert.ok(body.includes('Unsere Basis: v2.25.1'));
  assert.ok(
    body.includes(
      'https://github.com/gitroomhq/postiz-app/compare/v2.25.1...v2.26.0'
    )
  );
  assert.ok(body.includes('`upstream-sync/2026-10`'));
  assert.ok(!body.includes('-security`'));
  assert.ok(body.includes('docs/STAGING-TESTPLAN.md'));
  assert.ok(body.includes('Fork-`ROADMAP.md` und Hub-ROADMAP'));
  assert.ok(body.includes('nie an einem Tag mit vielen geplanten Posts'));
  assert.ok(body.includes('Kein Sicherheitsrelease erkannt'));
  assert.ok(!body.includes('Bitte prüfen'));
  assert.ok(body.includes('- [ ] '));
});

test('issue body for a security release never copies release notes', () => {
  const latest = release('v2.25.1');
  // The fixture has what must stay out: a mention, a PR link, an advisory ID.
  assert.ok(latest.body.includes('@beispiel-person'));
  assert.match(latest.body, /\/pull\/\d+/);
  assert.ok(latest.body.includes('PSA-2099-AAAA'));
  const { body, security } = buildIssueBody({
    latest,
    base: 'v2.25.0',
    newer: [latest],
    now: NOW,
  });
  assert.equal(security, true);
  assert.ok(body.includes('`upstream-sync/2026-10-security`'));
  assert.ok(body.includes('sofort synchronisieren'));
  assert.ok(body.includes('Sicherheit: v2.25.1 (upgrade immediately, PSA)'));
  assert.ok(!body.includes('Bitte prüfen'));
  // Release notes mention people and PRs. None of that may end up in our issue.
  assert.ok(!body.includes('@'));
  assert.ok(!/\/pull\/\d+/.test(body));
  assert.ok(!body.includes('PSA-2099'));
});

test('issue body for weak wording asks to check, without security sync', () => {
  const latest = release('v2.23.0');
  const { body, security } = buildIssueBody({
    latest,
    base: 'v2.22.1',
    newer: [latest],
    now: NOW,
  });
  assert.equal(security, false);
  assert.ok(
    body.includes(
      'Sicherheit: kein eindeutiger Hinweis in Name oder Release-Notes'
    )
  );
  assert.ok(body.includes('Bitte prüfen: v2.23.0 (security)'));
  assert.ok(body.includes('das Label `sicherheit` setzen'));
  assert.ok(!body.includes('**Sicherheitsrelease'));
  assert.ok(
    body.includes(
      '`upstream-sync/2026-10` (bei einem Sicherheitsfix `upstream-sync/2026-10-security`)'
    )
  );
});

// --- run --------------------------------------------------------------------

test('does nothing when upstream is not newer', async () => {
  const fake = fakeGithub({ latest: release('v2.25.1') });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'up-to-date');
  assert.equal(fake.calls.pages, 0);
  assert.equal(fake.calls.create.length, 0);
});

test('does nothing when upstream is older than the base', async () => {
  const fake = fakeGithub({ latest: release('v2.25.0') });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'up-to-date');
  assert.equal(fake.calls.create.length, 0);
});

test('opens one issue for a regular release, without label', async () => {
  const fake = fakeGithub({
    latest: release('v2.26.0'),
    releases: [release('v2.26.0'), ...fixtures.upstream_wording],
  });
  const core = fakeCore();
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core, patchesPath, now: NOW })
  );
  assert.equal(result.action, 'created');
  assert.equal(fake.calls.create.length, 1);
  const [created] = fake.calls.create;
  assert.equal(created.owner, 'example-org');
  assert.equal(created.repo, 'postiz');
  assert.equal(created.title, 'Postiz v2.26.0 verfügbar');
  assert.deepEqual(created.labels, []);
  // The POST must not be retried by octokit, or a 5xx could create two issues.
  assert.deepEqual(created.request, { retries: 0 });
  assert.equal(fake.calls.getLabel, 0);
  assert.ok(core.logs.some(([level]) => level === 'notice'));
});

test('labels a security release hidden behind a later regular release', async () => {
  const fake = fakeGithub({
    latest: release('v2.26.0'),
    releases: ALL,
  });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'created');
  assert.equal(result.security, true);
  const [created] = fake.calls.create;
  assert.deepEqual(created.labels, ['sicherheit']);
  assert.ok(created.body.includes('v2.25.2 (CVE)'));
  assert.ok(created.body.includes('`upstream-sync/2026-10-security`'));
  // The label did not exist yet and was created once.
  assert.equal(fake.calls.createLabel.length, 1);
  assert.equal(fake.calls.createLabel[0].name, 'sicherheit');
});

test('reuses an existing sicherheit label', async () => {
  const fake = fakeGithub({
    latest: release('v2.25.2'),
    releases: ALL,
    labels: ['sicherheit'],
  });
  await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(fake.calls.getLabel, 1);
  assert.equal(fake.calls.createLabel.length, 0);
  assert.deepEqual(fake.calls.create[0].labels, ['sicherheit']);
});

test('weak wording alone opens the issue without label', async () => {
  const patches = PATCHES_V2251.replace('v2.25.1', 'v2.22.1');
  const fake = fakeGithub({ latest: release('v2.23.0'), releases: ALL });
  const result = await withPatchesFile(patches, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'created');
  assert.equal(result.security, false);
  const [created] = fake.calls.create;
  assert.deepEqual(created.labels, []);
  assert.ok(created.body.includes('Bitte prüfen: v2.23.0 (security)'));
  assert.equal(fake.calls.getLabel, 0);
  assert.equal(fake.calls.createLabel.length, 0);
});

test('a second run does not create a duplicate', async () => {
  const fake = fakeGithub({ latest: release('v2.26.0'), releases: ALL });
  await withPatchesFile(PATCHES_V2251, async (patchesPath) => {
    const args = {
      ...fake,
      context: CONTEXT,
      core: fakeCore(),
      patchesPath,
      now: NOW,
    };
    assert.equal((await run(args)).action, 'created');
    const second = await run(args);
    assert.equal(second.action, 'exists');
    assert.equal(second.issue, 101);
  });
  assert.equal(fake.calls.create.length, 1);
});

test('a closed issue with the same title on a later page counts as duplicate', async () => {
  const filler = Array.from({ length: 5 }, (_, i) => ({
    number: i + 1,
    title: `Anderes Thema ${i + 1}`,
    state: 'open',
  }));
  const fake = fakeGithub({
    latest: release('v2.26.0'),
    releases: ALL,
    pageSize: 2,
    issues: [
      ...filler,
      {
        number: 9,
        title: ' postiz v2.26.0  VERFÜGBAR ',
        state: 'closed',
        user: BOT,
      },
      {
        number: 10,
        title: 'Postiz v2.25.9 verfügbar',
        state: 'closed',
        user: BOT,
      },
    ],
  });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'exists');
  assert.equal(result.issue, 9);
  assert.equal(fake.calls.pages, 3);
  assert.equal(fake.calls.create.length, 0);
  assert.equal(fake.calls.listReleases, 0);
});

test('a pull request with the same title is not a duplicate', async () => {
  const fake = fakeGithub({
    latest: release('v2.26.0'),
    releases: ALL,
    issues: [
      {
        number: 7,
        title: 'Postiz v2.26.0 verfügbar',
        state: 'open',
        user: BOT,
        pull_request: { url: 'https://example.invalid/pr/7' },
      },
    ],
  });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'created');
});

test('an issue with the same title by someone else is not a duplicate', async () => {
  // The fork is public: anyone can open and close a look-alike issue. It must
  // not suppress the notice for a security release.
  assert.equal(ISSUE_AUTHOR, BOT.login);
  const fake = fakeGithub({
    latest: release('v2.25.2'),
    releases: ALL,
    issues: [
      {
        number: 5,
        title: 'Postiz v2.25.2 verfügbar',
        state: 'closed',
        user: { login: 'some-outsider', type: 'User' },
      },
      {
        number: 4,
        title: 'Postiz v2.25.2 verfügbar',
        state: 'open',
        user: { login: 'other-app[bot]', type: 'Bot' },
      },
      { number: 3, title: 'Postiz v2.25.2 verfügbar', state: 'closed' },
    ],
  });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({ ...fake, context: CONTEXT, core: fakeCore(), patchesPath, now: NOW })
  );
  assert.equal(result.action, 'created');
  assert.equal(result.security, true);
  assert.equal(fake.calls.create.length, 1);
  assert.deepEqual(fake.calls.create[0].labels, ['sicherheit']);
});

test('dry run writes nothing', async () => {
  const fake = fakeGithub({ latest: release('v2.26.0'), releases: ALL });
  const result = await withPatchesFile(PATCHES_V2251, (patchesPath) =>
    run({
      ...fake,
      context: CONTEXT,
      core: fakeCore(),
      patchesPath,
      now: NOW,
      dryRun: true,
    })
  );
  assert.equal(result.action, 'dry-run');
  assert.deepEqual(result.labels, ['sicherheit']);
  assert.equal(fake.calls.create.length, 0);
  assert.equal(fake.calls.getLabel, 0);
  assert.equal(fake.calls.createLabel.length, 0);
});

test('fails loudly without a base version', async () => {
  const fake = fakeGithub({ latest: release('v2.26.0') });
  await assert.rejects(
    withPatchesFile('# leer\n', (patchesPath) =>
      run({
        ...fake,
        context: CONTEXT,
        core: fakeCore(),
        patchesPath,
        now: NOW,
      })
    ),
    /Basis-Version nicht gefunden/
  );
  assert.equal(fake.calls.latest, 0);
});

test('fails loudly on an unreadable upstream tag', async () => {
  const fake = fakeGithub({
    latest: { ...release('v2.26.0'), tag_name: 'nightly' },
  });
  await assert.rejects(
    withPatchesFile(PATCHES_V2251, (patchesPath) =>
      run({
        ...fake,
        context: CONTEXT,
        core: fakeCore(),
        patchesPath,
        now: NOW,
      })
    ),
    /Version nicht lesbar/
  );
});

// --- workflow ---------------------------------------------------------------

const WORKFLOW = join(
  REPO_ROOT,
  '.github/workflows/ysocial-upstream-check.yml'
);

// Returns the block scalar after `script: |` without its indentation.
function inlineScript(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
  assert.ok(start >= 0, 'script: | not found');
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const own = indentOf(lines[start]);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= own) break;
    block.push(line);
  }
  const strip = Math.min(...block.filter((l) => l.trim()).map(indentOf));
  return block.map((l) => l.slice(strip)).join('\n');
}

test('the inline github-script calls run() like the action does', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const source = inlineScript(yaml);
  assert.ok(!source.includes('${{'), 'no expressions inside the script');

  const base = parseBaseVersion(
    await readFile(join(REPO_ROOT, 'YSOCIAL-PATCHES.md'), 'utf8')
  );
  const fake = fakeGithub({
    latest: { ...release('v2.26.0'), tag_name: base },
  });
  const saved = { ws: process.env.GITHUB_WORKSPACE, dry: process.env.DRY_RUN };
  process.env.GITHUB_WORKSPACE = REPO_ROOT;
  process.env.DRY_RUN = 'true';
  try {
    // Same wrapper as actions/github-script (src/async-function.ts).
    const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
    const fn = new AsyncFunction('github', 'context', 'core', source);
    const result = await fn(fake.github, CONTEXT, fakeCore());
    assert.equal(result.action, 'up-to-date');
    assert.equal(result.base, base);
    assert.equal(fake.calls.latest, 1);
  } finally {
    for (const [key, value] of [
      ['GITHUB_WORKSPACE', saved.ws],
      ['DRY_RUN', saved.dry],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the sparse checkout contains the script the workflow imports', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const sparse = yaml.match(/sparse-checkout:\s*(\S+)\s*$/m);
  assert.ok(sparse, 'sparse-checkout not found');
  const imported = inlineScript(yaml).match(/\$\{workspace\}\/(\S+?\.mjs)/);
  assert.ok(imported, 'import path not found');
  assert.ok(
    imported[1].startsWith(`${sparse[1].replace(/\/$/, '')}/`),
    `${imported[1]} is outside ${sparse[1]}`
  );
  assert.equal(
    join(REPO_ROOT, imported[1]),
    join(HERE, 'ysocial-upstream-check.mjs')
  );
});

test('workflow: Monday 06:17 UTC, minimal permissions, actions pinned by SHA', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  // Off the full hour, where GitHub delays or drops scheduled runs.
  assert.match(yaml, /cron:\s*["']17 6 \* \* 1["']/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /^permissions:\s*\{\}\s*$/m);
  assert.match(yaml, /contents:\s*read/);
  assert.match(yaml, /issues:\s*write/);
  assert.doesNotMatch(yaml, /write-all|pull-requests:|contents:\s*write/);
  // GITHUB_TOKEN only: github-script uses it by default, no secret is referenced.
  assert.doesNotMatch(yaml, /secrets\.\w/);
  const uses = [...yaml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const ref of uses) {
    assert.match(ref, /^actions\/(checkout|github-script)@[0-9a-f]{40}$/, ref);
  }
});
