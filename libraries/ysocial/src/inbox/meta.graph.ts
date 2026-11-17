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

// Hide, unhide and delete answer {"success": true}. Anything else counts as
// a refusal.
export const expectSuccess = (result: GraphObject) => {
  if (result?.success !== true) {
    throw new InboxPlatformError({
      unavailable: false,
      status: 200,
      reason: 'Die Plattform hat den Erfolg nicht bestätigt.',
    });
  }
};
