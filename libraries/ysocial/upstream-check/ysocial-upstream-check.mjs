// ysocial: weekly check for a new Postiz release.
//
// Called by .github/workflows/ysocial-upstream-check.yml through
// actions/github-script. The workflow passes the authenticated Octokit client
// (`github`), `context` and `core`. Only `run`, `findIssueByTitle` and
// `ensureSecurityLabel` call the API, everything else is pure. Tests:
// ysocial-upstream-check.test.mjs (node --test, no network).
//
// Flow: read our base version from YSOCIAL-PATCHES.md, read the latest
// upstream release, and if it is newer open exactly one issue
// "Postiz <tag> verfügbar". Open and closed issues with the same title count
// as duplicates, but only those the workflow itself created: the fork is
// public, anyone can open (and close) an issue with that title. Releases with
// a clear security notice get the label `sicherheit`; a bare mention of
// security only adds a hint to check.
//
// Lives in libraries/ysocial/ because it is our own code (HANDOVER §10.8).
// It is plain ESM without dependencies: the workflow checks out only this
// folder and imports the file directly, nothing is installed or built.

import { readFile } from 'node:fs/promises';

export const UPSTREAM = { owner: 'gitroomhq', repo: 'postiz-app' };
// Author of issues created with GITHUB_TOKEN. Logins with "[bot]" cannot be
// registered by users. If the workflow ever switches to a GitHub App token,
// this login changes too.
export const ISSUE_AUTHOR = 'github-actions[bot]';
export const SECURITY_LABEL = {
  name: 'sicherheit',
  color: 'b60205',
  description: 'Sicherheitsrelease von Postiz: sofort synchronisieren (E11)',
};

// Strong signals set the label `sicherheit`. Upstream marks security releases
// with "This release addresses the security vulnerability <advisory ID>, all
// users are recommended to upgrade immediately." Advisory IDs: PSA-yyyy-…
// (upstream's own), GHSA-…, CVE-yyyy-….
const STRONG_PATTERNS = [
  { label: 'upgrade immediately', re: /upgrade\s+immediately/i },
  { label: 'CVE', re: /\bCVE-\d{4}-\d+/i },
  { label: 'GHSA', re: /\bGHSA-\w{4}-/i },
  { label: 'PSA', re: /\bPSA-\d{4}-/i },
];
// Weak signals only add "please check" to the issue, without label. They also
// match releases that merely touch the topic, e.g. a new contact address for
// security reports (v2.20.0).
const WEAK_PATTERNS = [
  { label: 'security', re: /security/i },
  { label: 'Sicherheit', re: /sicherheit/i },
  { label: 'vulnerability', re: /vulnerab/i },
];

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/**
 * Parses "v2.25.1", "2.25.1" or "v2.26.0-rc.1".
 * Returns null when the string holds no x.y.z version.
 */
export function parseVersion(tag) {
  const match = VERSION_RE.exec(String(tag ?? ''));
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(a, b) {
  // A release without prerelease ranks above any prerelease (semver 11.3).
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const diff = Number(pa[i]) - Number(pb[i]);
      if (diff !== 0) return Math.sign(diff);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Returns -1, 0 or 1. Throws when one side is not a version. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) {
    throw new Error(`Version nicht lesbar: "${a}" oder "${b}"`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) {
      return va[key] > vb[key] ? 1 : -1;
    }
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** "v2.25.1" for any parsable input. */
export function normalizeTag(tag) {
  const v = parseVersion(tag);
  if (!v) {
    throw new Error(`Version nicht lesbar: "${tag}"`);
  }
  return `v${v.major}.${v.minor}.${v.patch}${
    v.prerelease ? `-${v.prerelease}` : ''
  }`;
}

/**
 * Reads the upstream base version from YSOCIAL-PATCHES.md.
 *
 * Expected line (header list): "- Basis: upstream v2.25.1 (11.10.2026)".
 * Tolerates bold, backticks, case and a missing "v". The version must follow
 * "upstream" or carry a "v" prefix, so the date "11.10.2026" never matches.
 * Only "Basis:" lines count, nothing else in the file. Throws when no Basis
 * line holds a version or when Basis lines disagree (fail loud, as documented
 * in YSOCIAL-PATCHES.md).
 */
export function parseBaseVersion(markdown) {
  const text = String(markdown ?? '');
  const versionAfterUpstream =
    /\bupstream\s*[`*_]*\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/gi;
  const versionWithV = /(?:^|[\s`*_(])v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/gi;

  const basisLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]\s+)?[*_]*\s*basis\s*[*_]*\s*:/i.test(line));

  const fromLines = (lines, ...patterns) => {
    const found = new Set();
    for (const line of lines) {
      for (const re of patterns) {
        re.lastIndex = 0;
        const match = re.exec(line);
        if (match) {
          found.add(normalizeTag(match[1]));
          break;
        }
      }
    }
    return [...found];
  };

  const candidates = fromLines(basisLines, versionAfterUpstream, versionWithV);

  if (candidates.length === 0) {
    throw new Error(
      'Basis-Version nicht gefunden. YSOCIAL-PATCHES.md braucht eine Zeile wie "- Basis: upstream v2.25.1 (11.10.2026)".'
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Basis-Version nicht eindeutig: ${candidates.join(
        ', '
      )}. YSOCIAL-PATCHES.md korrigieren.`
    );
  }
  return candidates[0];
}

/**
 * Keyword hits in release name and body, split by strength, e.g.
 * { strong: ["upgrade immediately", "PSA"], weak: ["security"] }.
 */
export function securityHits(release) {
  const text = `${release?.name ?? ''}\n${release?.body ?? ''}`;
  const hits = (patterns) =>
    patterns.filter(({ re }) => re.test(text)).map(({ label }) => label);
  return { strong: hits(STRONG_PATTERNS), weak: hits(WEAK_PATTERNS) };
}

/**
 * Stable releases newer than `base` and not newer than `latest`, newest
 * first. Drafts, prereleases and unparsable tags are skipped. `latest` is
 * always included, even when the list call missed it.
 */
export function newerReleases(releases, base, latest) {
  const byTag = new Map();
  for (const release of [latest, ...(releases ?? [])]) {
    if (!release || release.draft || release.prerelease) continue;
    if (!parseVersion(release.tag_name)) continue;
    if (byTag.has(release.tag_name)) continue;
    if (compareVersions(release.tag_name, base) <= 0) continue;
    if (compareVersions(release.tag_name, latest.tag_name) > 0) continue;
    byTag.set(release.tag_name, release);
  }
  return [...byTag.values()].sort((a, b) =>
    compareVersions(b.tag_name, a.tag_name)
  );
}

export function issueTitle(tag) {
  return `Postiz ${tag} verfügbar`;
}

function sameTitle(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  return norm(a) === norm(b);
}

const BERLIN = 'Europe/Berlin';

/** "11.10.2026" in Europe/Berlin. */
export function formatDate(iso) {
  if (!iso) return 'unbekannt';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}

/** "upstream-sync/2026-10" or "upstream-sync/2026-10-security". */
export function syncBranch(now, security) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `upstream-sync/${year}-${month}${security ? '-security' : ''}`;
}

/**
 * Issue body in German. Only tags, dates and links from upstream go in.
 * Release notes are not copied: their @mentions and PR links would notify
 * people upstream and add cross-references there.
 */
export function buildIssueBody({ latest, base, newer, now }) {
  const flagged = newer.map((release) => ({
    tag: release.tag_name,
    ...securityHits(release),
  }));
  const strong = flagged.filter((entry) => entry.strong.length > 0);
  const weakOnly = flagged.filter(
    (entry) => entry.strong.length === 0 && entry.weak.length > 0
  );
  const security = strong.length > 0;
  const branch = syncBranch(now, security);
  const compareUrl = `https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}/compare/${base}...${latest.tag_name}`;

  const newerTags = newer.map((r) => r.tag_name).join(', ');
  const listHits = (entries, key) =>
    entries
      .map((entry) => `${entry.tag} (${entry[key].join(', ')})`)
      .join('; ');

  const lines = [
    'Der Workflow `ysocial-upstream-check` hat ein neues Postiz-Release gefunden.',
    '',
    `- Neues Release: [${latest.tag_name}](${latest.html_url})`,
    `- Veröffentlicht: ${formatDate(latest.published_at)}`,
    `- Unsere Basis: ${base} (laut \`YSOCIAL-PATCHES.md\`)`,
    `- Releases seit der Basis: ${newerTags}`,
    `- Änderungen: [${base}...${latest.tag_name}](${compareUrl})`,
    `- Sicherheit: ${
      security
        ? listHits(strong, 'strong')
        : 'kein eindeutiger Hinweis in Name oder Release-Notes'
    }`,
  ];
  if (weakOnly.length > 0) {
    lines.push(`- Bitte prüfen: ${listHits(weakOnly, 'weak')}`);
  }
  lines.push('');

  if (security) {
    lines.push(
      '**Sicherheitsrelease: sofort synchronisieren, nicht auf den Monatstermin warten (E11).**',
      ''
    );
  } else if (weakOnly.length > 0) {
    lines.push(
      'Kein eindeutiges Sicherheitsrelease erkannt, aber die Release-Notes erwähnen Sicherheit. Diese Wörter allein setzen kein Label. Release-Notes lesen: Ist es ein Sicherheitsfix, das Label `sicherheit` setzen und sofort synchronisieren (E11). Sonst kommt der Sync in den nächsten Monats-PR.',
      ''
    );
  } else {
    lines.push(
      'Kein Sicherheitsrelease erkannt. Der Sync kommt in den nächsten Monats-PR (E11). Die Release-Notes trotzdem lesen: Die Erkennung sucht nur nach Stichworten.',
      ''
    );
  }

  const branchText =
    !security && weakOnly.length > 0
      ? `\`${branch}\` (bei einem Sicherheitsfix \`${syncBranch(now, true)}\`)`
      : `\`${branch}\``;

  lines.push(
    '## Checkliste',
    '',
    `- [ ] Release-Notes von ${newerTags} gelesen: neue Pflicht-Variablen, Schema-Änderungen, neue Workflow-Versionen`,
    `- [ ] Branch ${branchText} vom Tag \`${latest.tag_name}\` angelegt, nie von upstream-\`main\``,
    '- [ ] Ablauf aus `YSOCIAL-PATCHES.md`, Abschnitt „Upstream-Sync“: Änderungen in `.github/workflows/`, `.claude/` und `CLAUDE.md` gelesen, neue Upstream-Workflows abgeschaltet, jeder Patch geprüft',
    '- [ ] Termin geprüft: nie an einem Tag mit vielen geplanten Posts',
    '- [ ] Staging nach `docs/STAGING-TESTPLAN.md` geprüft, Protokoll im Sync-PR unter `# QA`',
    '- [ ] Florian hat gemergt, erst danach Produktion',
    '- [ ] Basis in `YSOCIAL-PATCHES.md`, Fork-`ROADMAP.md` und Hub-ROADMAP aktualisiert',
    '- [ ] Ältere offene Issues „Postiz … verfügbar“ mit Verweis auf dieses geschlossen',
    ''
  );

  return { body: lines.join('\n'), security };
}

/**
 * Finds an issue (open or closed, no pull requests) with the given title that
 * this workflow created (ISSUE_AUTHOR). Issues by anyone else never count, so
 * an outsider cannot suppress a security notice with a look-alike issue.
 * Uses the list endpoint, not search: search is eventually consistent and
 * would miss an issue created a minute ago.
 */
export async function findIssueByTitle(github, repo, title) {
  const hits = await github.paginate(
    github.rest.issues.listForRepo,
    { ...repo, state: 'all', per_page: 100 },
    (response, done) => {
      const hit = response.data.find(
        (issue) =>
          !issue.pull_request &&
          issue.user?.login === ISSUE_AUTHOR &&
          sameTitle(issue.title, title)
      );
      if (hit) done();
      return hit ? [hit] : [];
    }
  );
  return hits[0] ?? null;
}

async function ensureSecurityLabel(github, repo) {
  try {
    await github.rest.issues.getLabel({ ...repo, name: SECURITY_LABEL.name });
  } catch (error) {
    if (error?.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({ ...repo, ...SECURITY_LABEL });
    } catch (createError) {
      // 422: created in the meantime by a parallel run.
      if (createError?.status !== 422) throw createError;
    }
  }
}

/**
 * Entry point for actions/github-script.
 * Returns what happened, for logs and tests.
 */
export async function run({
  github,
  context,
  core,
  patchesPath,
  now = new Date(),
  dryRun = false,
}) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };

  const base = parseBaseVersion(await readFile(patchesPath, 'utf8'));
  core.info(`Basis laut YSOCIAL-PATCHES.md: ${base}`);

  const { data: latest } = await github.rest.repos.getLatestRelease(UPSTREAM);
  core.info(`Neuestes Release upstream: ${latest.tag_name}`);
  // Throws on an unreadable tag. The run fails and someone looks at it.
  if (compareVersions(latest.tag_name, base) <= 0) {
    core.info('Kein neueres Release. Nichts zu tun.');
    return { action: 'up-to-date', base, latest: latest.tag_name };
  }

  const title = issueTitle(latest.tag_name);
  const existing = await findIssueByTitle(github, repo, title);
  if (existing) {
    core.info(
      `Issue #${existing.number} „${existing.title}“ gibt es schon (${existing.state}). Kein neues Issue.`
    );
    return {
      action: 'exists',
      base,
      latest: latest.tag_name,
      issue: existing.number,
    };
  }

  // One extra call so a security release between base and latest is not
  // hidden behind a later regular release.
  const { data: recent } = await github.rest.repos.listReleases({
    ...UPSTREAM,
    per_page: 100,
  });
  const newer = newerReleases(recent, base, latest);
  const { body, security } = buildIssueBody({ latest, base, newer, now });
  const labels = security ? [SECURITY_LABEL.name] : [];

  if (dryRun) {
    core.info(
      `Probelauf: Issue „${title}“ würde angelegt, Labels: ${
        labels.join(', ') || 'keine'
      }.`
    );
    core.info(body);
    return {
      action: 'dry-run',
      base,
      latest: latest.tag_name,
      security,
      title,
      body,
      labels,
    };
  }

  if (security) {
    await ensureSecurityLabel(github, repo);
  }
  // No automatic retry for this POST: on a 5xx GitHub may already have stored
  // the issue, and a retry would create a second one. A failed create fails
  // the run; the duplicate check of the next run covers a stored issue.
  // The label call above may retry: a repeated createLabel ends in 422.
  const { data: issue } = await github.rest.issues.create({
    ...repo,
    title,
    body,
    labels,
    request: { retries: 0 },
  });
  core.notice(`Issue #${issue.number} angelegt: ${title}`);
  return {
    action: 'created',
    base,
    latest: latest.tag_name,
    security,
    issue: issue.number,
  };
}
