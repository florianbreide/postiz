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

  const body: GraphObject | undefined = await res.json().catch(() => undefined);
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
  return body || {};
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
 * - Instagram fields like comments cannot be subscribed through this edge,
 *   only in the App Dashboard. With Facebook Login the app still has to be
 *   on the linked Page: POST to its subscribed_apps edge, "/me" with the
 *   Page token.
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
