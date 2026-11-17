import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { sanitizeReason } from '../events/hub.event';
import { InboxPlatformError } from './inbox.rules';

/**
 * One call to the Graph API (graph.facebook.com, same version as Postiz) for
 * the inbox providers of Instagram and Facebook. The caller checks the ids in
 * the path and picks the Page token.
 *
 * The token goes in the query (GET, DELETE) or the form body (POST), never
 * into a log or an error. So does the text of a reply: in the body, not in
 * the URL.
 */

const GRAPH_TIMEOUT_MS = 15_000;

export type GraphObject = Record<string, any>;

// A text field of a Graph answer, null when missing or empty.
export const text = (value: unknown) =>
  typeof value === 'string' && value ? value : null;

// A count of a Graph answer, 0 when missing or not a positive number.
export const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

export const metaGraph = async (
  method: 'GET' | 'POST' | 'DELETE',
  accessToken: string,
  path: string,
  params: Record<string, string>
): Promise<GraphObject> => {
  const values = new URLSearchParams({
    ...params,
    access_token: accessToken,
  });
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`;

  let res: Response;
  try {
    res = await fetch(method === 'POST' ? url : `${url}?${values}`, {
      method,
      ...(method === 'POST' ? { body: values } : {}),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout. The cause is not passed on, it may
    // carry the URL with the token.
    throw new InboxPlatformError({ unavailable: true });
  }

  // Only a JSON object counts as an answer. An empty body (204), HTML, a
  // body cut off or a bare value like true is not readable. When the 15 s
  // run out while the body comes in, that is no answer at all, as before
  // the headers.
  let timedOut = false;
  const parsed: unknown = await res.json().catch((err) => {
    timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return undefined;
  });
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as GraphObject)
      : undefined;
  if (!res.ok || body?.error) {
    const error = body?.error || {};
    throw new InboxPlatformError({
      unavailable: false,
      status: res.status,
      code: typeof error.code === 'number' ? error.code : undefined,
      subcode:
        typeof error.error_subcode === 'number'
          ? error.error_subcode
          : undefined,
      reason:
        typeof error.message === 'string'
          ? sanitizeReason(error.message)
          : undefined,
    });
  }
  if (!body) {
    if (timedOut) {
      throw new InboxPlatformError({ unavailable: true });
    }
    // 2xx without a readable answer: the status says yes, the body says
    // nothing. A write may have happened (the service turns this into
    // outcome_unknown), a read has nothing to show.
    throw new InboxPlatformError({
      unavailable: false,
      unreadable: true,
      status: res.status,
      reason: 'Die Plattform hat keine lesbare Antwort geschickt.',
    });
  }
  return body;
};

// Hide, unhide, delete and the webhook subscription answer
// {"success": true}. Anything else counts as a refusal.
export const expectSuccess = (result: GraphObject) => {
  if (result?.success !== true) {
    throw new InboxPlatformError({
      unavailable: false,
      status: 200,
      reason: 'Die Plattform hat den Erfolg nicht bestätigt.',
    });
  }
};

/**
 * Webhooks of a Page for the demo: our app on the Page and its fields.
 * Facebook calls this for the Page of the channel, Instagram (Facebook
 * Login) for the linked Page through "me" with the Page token.
 *
 * - POST /{page-id}/subscribed_apps with subscribed_fields, GET for the
 *   state: Page token of a person with the task CREATE_CONTENT, MANAGE or
 *   MODERATE, pages_manage_metadata and pages_show_list. POST answers
 *   {"success": true}, GET the apps on the Page with subscribed_fields.
 *   https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps
 * - Instagram, Facebook Login: "Send a POST request to the linked Page's
 *   /subscribed_apps edge", "You can use /me when the token represents the
 *   linked Facebook Page". The same guide wants "the fields selected in the
 *   App Dashboard", while the subscribed_apps reference says: "You cannot
 *   use the subscribed_fields parameter to configure or subscribe to
 *   Webhooks for Instagram." So the Page field feed for the linked Page is
 *   an assumption (README, ungeprüft). comments is set in the App Dashboard.
 *   https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
 */

// The Page field the demo subscribes: posts, comments and reactions of the
// Page.
export const PAGE_WEBHOOK_FIELDS = ['feed'];

// The app Postiz uses for Facebook Login. Its webhooks Meta signs with
// FACEBOOK_APP_SECRET.
export const META_APP_ID_ENV = 'FACEBOOK_APP_ID';

export const subscribePageWebhooks = async (
  accessToken: string,
  node: string
) => {
  expectSuccess(
    await metaGraph('POST', accessToken, `${node}/subscribed_apps`, {
      subscribed_fields: PAGE_WEBHOOK_FIELDS.join(','),
    })
  );
  return { fields: PAGE_WEBHOOK_FIELDS };
};

// Only the entry of our own app counts. Names and ids of other apps on the
// Page never leave this function. Without FACEBOOK_APP_ID: not subscribed.
export const pageWebhookSubscription = async (
  accessToken: string,
  node: string
) => {
  const appId = process.env[META_APP_ID_ENV];
  const result = await metaGraph(
    'GET',
    accessToken,
    `${node}/subscribed_apps`,
    {}
  );
  const app = Array.isArray(result?.data)
    ? result.data.find(
        (row: GraphObject) => !!appId && String(row?.id) === appId
      )
    : undefined;
  const fields: string[] = Array.isArray(app?.subscribed_fields)
    ? app.subscribed_fields.filter(
        (field: unknown) =>
          typeof field === 'string' && /^[a-z_]{1,40}$/.test(field)
      )
    : [];
  return { subscribed: !!app, fields };
};
