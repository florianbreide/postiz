import { createHmac } from 'crypto';
import {
  tokensMatch,
  YSOCIAL_SERVICE_TOKEN_MIN_LENGTH,
} from '../service.token';

/**
 * Meta webhooks for the inbox demo (E25, video for pages_manage_metadata
 * and the webhook fields feed and comments, Hub meta.md §6). Pure
 * functions and types: the check of the verification request and of the
 * signature, and the reduction of a notification to what the demo log may
 * hold. Receiver: apps/backend/src/ysocial/ysocial.meta.webhook.controller.ts.
 *
 * Official Meta reference (read 17.11.2026):
 * - Verification request: GET with hub.mode=subscribe, hub.challenge and
 *   hub.verify_token. Check the token, answer with hub.challenge.
 * - Event notification: POST with JSON, signed with the App Secret in
 *   X-Hub-Signature-256 as "sha256=<hex>" (HMAC-SHA256 of the payload).
 *   Answer 200. Meta retries failed deliveries for up to 36 hours and may
 *   send one twice.
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * - Page field feed: value with item, verb, post_id, comment_id, parent_id,
 *   created_time, from and message.
 *   https://developers.facebook.com/docs/graph-api/webhooks/reference/page/#feed
 * - Instagram field comments (Facebook Login): value with comment_id (or
 *   id), parent_id, media.id, from and text.
 *   https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
 *
 * The log keeps ids, field, kind and time. Never message, text, from (name,
 * username or id of the person) or anything else of the value.
 */

export const YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV =
  'YSOCIAL_META_WEBHOOK_VERIFY_TOKEN';
// The App Secret Postiz uses for Facebook Login (facebook.provider.ts,
// instagram.provider.ts). Meta signs the webhooks of the app with it.
export const META_APP_SECRET_ENV = 'FACEBOOK_APP_SECRET';

type Env = Record<string, string | undefined>;

export type VerifyResult = 'ok' | 'not_configured' | 'invalid';

// A token shorter than the service token counts as not configured.
export const checkVerifyRequest = (
  env: Env,
  mode: unknown,
  token: unknown
): VerifyResult => {
  const configured = env[YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV];
  if (
    typeof configured !== 'string' ||
    configured.trim().length < YSOCIAL_SERVICE_TOKEN_MIN_LENGTH
  ) {
    return 'not_configured';
  }
  if (mode !== 'subscribe' || typeof token !== 'string' || !token) {
    return 'invalid';
  }
  return tokensMatch(configured.trim(), token) ? 'ok' : 'invalid';
};

// hub.challenge is an int per the reference. Only digits go back, so the
// answer never carries anything else.
export const isChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,64}$/.test(value);

export type SignatureResult = 'ok' | 'not_configured' | 'missing' | 'invalid';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

// Compared in constant time, like the service token.
export const checkSignature = (
  env: Env,
  rawBody: Buffer | undefined,
  header: string | string[] | undefined
): SignatureResult => {
  const secret = env[META_APP_SECRET_ENV];
  if (typeof secret !== 'string' || !secret.trim()) {
    return 'not_configured';
  }
  const value = Array.isArray(header) ? header[0] : header;
  const match =
    typeof value === 'string' ? SIGNATURE_PATTERN.exec(value) : null;
  if (!match) {
    return 'missing';
  }
  if (!Buffer.isBuffer(rawBody)) {
    return 'invalid';
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return tokensMatch(expected, match[1].toLowerCase()) ? 'ok' : 'invalid';
};

// The demo log in the Redis of Postiz: the latest 50 events, gone 24 hours
// after the last one. No table (HANDOVER §5).
export const WEBHOOK_LOG_KEY = 'ysocial:demo:meta-webhook-events';
export const WEBHOOK_LOG_LIMIT = 50;
export const WEBHOOK_LOG_TTL_S = 24 * 60 * 60;

// The objects of the demo. Everything else is left out.
export const WEBHOOK_OBJECTS = ['page', 'instagram'];

export interface WebhookEvent {
  receivedAt: string;
  // "page" or "instagram"
  object: string;
  // Page id or Instagram account id
  entryId: string | null;
  // When Meta sent the notification (entry.time)
  sentAt: string | null;
  field: string;
  // Page feed: item (comment, post, reaction …) and verb (add, edited,
  // remove, hide …). null for Instagram comments.
  item: string | null;
  verb: string | null;
  postId: string | null;
  commentId: string | null;
  parentId: string | null;
  mediaId: string | null;
  createdAt: string | null;
}

type Json = Record<string, any>;

const NAME_PATTERN = /^[a-z_]{1,40}$/;

const name = (value: unknown) =>
  typeof value === 'string' && NAME_PATTERN.test(value) ? value : null;

// Meta ids are digits, Page posts and comments <digits>_<digits>. Own check
// instead of the one of the inbox: the receiver does not import the inbox
// (rule 2, ysocial.inbox.no-automation.spec.ts).
const id = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string' && /^[0-9_]{1,64}$/.test(value)
    ? value
    : null;

// Unix seconds as Meta sends them in entry.time and value.created_time.
// Beyond the range of Date the value counts as invalid, toISOString would
// throw.
const time = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Reduces a notification to the fields of the log. Changes without a valid
 * field name are left out, so is everything that is not listed here.
 */
export const webhookEvents = (payload: unknown, now: Date): WebhookEvent[] => {
  const body = payload as Json;
  const object = name(body?.object);
  // Only Page and Instagram. For other objects of the app (user,
  // permissions …) entry.id would be the id of a person.
  if (
    !object ||
    !WEBHOOK_OBJECTS.includes(object) ||
    !Array.isArray(body?.entry)
  ) {
    return [];
  }
  return body.entry.flatMap((entry: Json) =>
    (Array.isArray(entry?.changes) ? entry.changes : []).flatMap(
      (change: Json) => {
        const field = name(change?.field);
        if (!field) {
          return [];
        }
        const value: Json =
          change.value && typeof change.value === 'object' ? change.value : {};
        return [
          {
            receivedAt: now.toISOString(),
            object,
            entryId: id(entry.id),
            sentAt: time(entry.time),
            field,
            item: name(value.item),
            verb: name(value.verb),
            postId: id(value.post_id),
            commentId: id(
              value.comment_id ??
                (object === 'instagram' ? value.id : undefined)
            ),
            parentId: id(value.parent_id),
            mediaId: id(value.media?.id),
            createdAt: time(value.created_time),
          },
        ];
      }
    )
  );
};
