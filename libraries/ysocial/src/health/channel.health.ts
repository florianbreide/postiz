import { createHubEvent, HubEvent, HubEventKind } from '../events/hub.event';

/**
 * Channel check (hourly, database fields only) and the channel part of
 * DailyHealth (PLAN 3.3 PR 18, E23, W35).
 *
 * The check remembers which channels it reported, so it can report
 * "wieder verbunden" and "entfernt" (state in Redis, see
 * ysocial.channel.health.service.ts). Ids come from the channel and its
 * updatedAt: the same state gives the same id, a reconnect a new one.
 * "Zugang ungültig" leaves updatedAt as it is, so its id and the one of the
 * way back also carry `since`, the run that first saw the problem.
 *
 * "Zugang ungültig" ends with a new token or with the next platform call
 * that passes, not with any other change of the channel (name, posting
 * times). The token itself is not read: Postiz writes tokenExpiration with
 * every new token that comes with an expiry (connect, reconnect, page
 * selection, refresh) and with nothing else. Exceptions: orchestrator
 * README, "Kanal-Prüfung und DailyHealth".
 */

export const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60_000;

export interface ChannelRow {
  id: string;
  organizationId: string;
  customerId: string | null;
  name: string;
  providerIdentifier: string;
  disabled: boolean;
  refreshNeeded: boolean;
  inBetweenSteps: boolean;
  tokenExpiration: Date | null;
  updatedAt: Date | null;
}

export type ChannelFlag = 'refresh_needed' | 'in_between_steps' | 'disabled';

export type ChannelProblemKind =
  | 'channel.disconnected'
  | 'channel.auth_invalid';

export interface ChannelProblemState {
  kind: ChannelProblemKind;
  // updatedAt of the channel when the problem was reported, in ms.
  updatedAt: number;
  // Run that first reported the problem. Kept while the problem lasts.
  since: string;
  // channel.auth_invalid only: tokenExpiration of the channel when the
  // platform last rejected it, in ms, null for none. Missing in states
  // written before 0.7.5, until a daily run rejects the channel again.
  tokenExpiration?: number | null;
}

export type ChannelProblems = Record<string, ChannelProblemState>;

// What one run changed for a channel: the state it started from and the one
// it leaves, null for none.
export interface ChannelProblemChange {
  before: ChannelProblemState | null;
  after: ChannelProblemState | null;
}

export type ChannelProblemChanges = Record<string, ChannelProblemChange>;

const FLAG_REASONS: Record<ChannelFlag, string> = {
  refresh_needed: 'Postiz verlangt, dass der Kanal neu verbunden wird.',
  in_between_steps: 'Die Verbindung des Kanals ist nicht abgeschlossen.',
  disabled: 'Der Kanal ist in Postiz deaktiviert.',
};

export const channelFlag = (row: ChannelRow): ChannelFlag | undefined =>
  row.refreshNeeded
    ? 'refresh_needed'
    : row.inBetweenSteps
    ? 'in_between_steps'
    : row.disabled
    ? 'disabled'
    : undefined;

export const tokenExpiry = (row: ChannelRow, now: number) => {
  const expiresAt = row.tokenExpiration?.getTime();
  if (!expiresAt || expiresAt > now + TOKEN_EXPIRY_WARN_MS) {
    return undefined;
  }
  return {
    expiresAt: new Date(expiresAt).toISOString(),
    expired: expiresAt <= now,
  };
};

const updatedMs = (row: ChannelRow) => row.updatedAt?.getTime() || 0;

const expirationMs = (row: ChannelRow) =>
  row.tokenExpiration?.getTime() ?? null;

const sinceMs = (state: ChannelProblemState) => Date.parse(state.since) || 0;

// The channel has a new token since the platform last rejected it. A state
// without tokenExpiration (before 0.7.5) cannot tell, it waits for the next
// platform call.
const newToken = (state: ChannelProblemState, row: ChannelRow) =>
  state.tokenExpiration !== undefined &&
  state.tokenExpiration !== expirationMs(row);

export const channelEvent = (
  kind: HubEventKind,
  row: Pick<ChannelRow, 'id'> & Partial<ChannelRow>,
  stateKey: string,
  now: number,
  reason: string,
  data: Record<string, string | number | boolean | null> = {}
): HubEvent =>
  createHubEvent({
    kind,
    subject: { type: 'channel', id: row.id },
    stateKey,
    occurredAt: new Date(now),
    postiz: {
      integrationId: row.id,
      ...(row.organizationId ? { organizationId: row.organizationId } : {}),
      ...(row.customerId !== undefined ? { customerId: row.customerId } : {}),
      ...(row.providerIdentifier
        ? { providerIdentifier: row.providerIdentifier }
        : {}),
    },
    reason,
    data,
  });

export const tokenExpiringEvent = (row: ChannelRow, now: number) => {
  const expiry = tokenExpiry(row, now);
  if (!expiry) {
    return undefined;
  }
  return channelEvent(
    'channel.token_expiring',
    row,
    String(row.tokenExpiration!.getTime()),
    now,
    expiry.expired
      ? 'Der Zugang des Kanals ist abgelaufen.'
      : 'Der Zugang des Kanals läuft in höchstens 7 Tagen ab.',
    expiry
  );
};

/**
 * Compares the channels with what was reported before.
 *
 * - flag set, not reported as disconnected: channel.disconnected
 * - flag gone after channel.disconnected: channel.reconnected
 * - channel.auth_invalid and a new token since (tokenExpiration changed):
 *   channel.reconnected. Other changes of the channel keep it.
 * - authInvalid (DailyHealth only): channel.auth_invalid, if not reported
 * - authOk (DailyHealth only) after channel.auth_invalid: channel.reconnected
 * - reported channel no longer there: channel.removed
 */
export const diffChannels = (input: {
  previous: ChannelProblems;
  channels: ChannelRow[];
  now: number;
  authInvalid?: Record<string, string>;
  authOk?: string[];
}): { events: HubEvent[]; next: ChannelProblems } => {
  const { channels, now } = input;
  const previous = input.previous || {};
  const authInvalid = input.authInvalid || {};
  const authOk = new Set(input.authOk || []);
  const next: ChannelProblems = {};
  const events: HubEvent[] = [];
  const since = new Date(now).toISOString();

  for (const row of channels) {
    const before = previous[row.id];
    const updated = updatedMs(row);
    const flag = channelFlag(row);

    if (flag) {
      if (before?.kind === 'channel.disconnected') {
        next[row.id] = before;
      } else {
        events.push(
          channelEvent(
            'channel.disconnected',
            row,
            `${flag}-${updated}`,
            now,
            FLAG_REASONS[flag],
            { flag }
          )
        );
        next[row.id] = {
          kind: 'channel.disconnected',
          updatedAt: updated,
          since,
        };
      }
      continue;
    }

    if (authInvalid[row.id]) {
      if (before?.kind === 'channel.auth_invalid') {
        // Still rejected, maybe with a newer token than the one reported.
        // Only a token after the one checked now ends the problem. The ids
        // stay, they carry updatedAt and since of the report.
        next[row.id] = { ...before, tokenExpiration: expirationMs(row) };
      } else {
        // A new problem after channel.reconnected keeps updatedAt. since,
        // this run, tells the two apart.
        events.push(
          channelEvent(
            'channel.auth_invalid',
            row,
            `${updated}-${now}`,
            now,
            `Zugang ungültig: Die Plattform lehnt den gespeicherten Zugang ab. ${
              authInvalid[row.id]
            }`.trim(),
            { check: 'analytics' }
          )
        );
        next[row.id] = {
          kind: 'channel.auth_invalid',
          updatedAt: updated,
          since,
          tokenExpiration: expirationMs(row),
        };
      }
      continue;
    }

    const reconnected =
      before?.kind === 'channel.disconnected' ||
      (before?.kind === 'channel.auth_invalid' &&
        (newToken(before, row) || authOk.has(row.id)));

    if (reconnected) {
      events.push(
        channelEvent(
          'channel.reconnected',
          row,
          `${updated}-${sinceMs(before!)}`,
          now,
          'Der Kanal ist wieder verbunden.',
          { previous: before!.kind }
        )
      );
    } else if (before) {
      // auth_invalid without a new token and without a new check: keep it.
      next[row.id] = before;
    }
  }

  const present = new Set(channels.map((row) => row.id));
  for (const [id, before] of Object.entries(previous)) {
    if (!present.has(id)) {
      events.push(
        channelEvent(
          'channel.removed',
          { id },
          String(before.updatedAt),
          now,
          'Der Kanal wurde in Postiz entfernt.',
          { previous: before.kind }
        )
      );
    }
  }

  return { events, next };
};

const sameProblem = (
  a: ChannelProblemState | null | undefined,
  b: ChannelProblemState | null | undefined
) =>
  !a || !b
    ? !a && !b
    : a.kind === b.kind &&
      a.updatedAt === b.updatedAt &&
      a.since === b.since &&
      a.tokenExpiration === b.tokenExpiration;

export const problemChanges = (
  previous: ChannelProblems,
  next: ChannelProblems
): ChannelProblemChanges => {
  const changes: ChannelProblemChanges = {};
  for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!sameProblem(previous[id], next[id])) {
      changes[id] = { before: previous[id] || null, after: next[id] || null };
    }
  }
  return changes;
};

// Applies the changes of one run to the state as it is now. A channel is
// written only if it still has the state the run started from: if another
// check changed it in between, its newer state stays, and the next run
// compares again. Applying the same changes twice gives the same result.
export const applyProblemChanges = (
  current: ChannelProblems,
  changes: ChannelProblemChanges
): ChannelProblems => {
  const result = { ...current };
  for (const [id, { before, after }] of Object.entries(changes)) {
    if (!sameProblem(current[id], before)) {
      continue;
    }
    if (after) {
      result[id] = after;
    } else {
      delete result[id];
    }
  }
  return result;
};

// Calendar day in Berlin, the key of the daily summary.
export const berlinDay = (now: number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
