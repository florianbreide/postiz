import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { sanitizeReason } from '../events/hub.event';
import {
  INBOX_COMMENTS_LIMIT,
  INBOX_POSTS_LIMIT,
  InboxChannel,
  InboxComment,
  InboxPlatformError,
  InboxPost,
  InboxReply,
  YsocialInboxProvider,
} from './inbox.rules';

/**
 * Inbox for the Postiz provider "instagram" (Instagram API with Facebook
 * Login, graph.facebook.com, same Graph version as Postiz). Not for
 * "instagram-standalone" (Instagram Login, graph.instagram.com).
 *
 * Endpoints and permissions, official Meta reference (read 12.11.2026):
 * - GET /{ig-user-id}/media: instagram_basic, pages_read_engagement or
 *   pages_show_list. Newest first, no stories.
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 * - GET /{ig-media-id}/comments: instagram_basic, instagram_manage_comments,
 *   pages_read_engagement. At most 50 per query, newest first, only
 *   top-level comments, replies through the field "replies". username
 *   needs instagram_manage_comments.
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments
 * - GET /{ig-comment-id} (fields media, parent_id), POST /{ig-comment-id}
 *   with hide=true|false, DELETE /{ig-comment-id}: instagram_basic,
 *   instagram_manage_comments, pages_read_engagement. Hide and delete only
 *   by the owner of the media. Comments of the owner itself stay visible
 *   even when hidden.
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
 * - POST /{ig-comment-id}/replies with message: instagram_basic,
 *   instagram_manage_comments, pages_show_list, pages_read_engagement. Only
 *   on top-level comments (a reply to a reply goes to the top-level
 *   comment), not on hidden comments, not on live videos.
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies
 * - GET /{ig-media-id} with field owner ({"id": …}): only returned to the
 *   account that created the media.
 *   https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media
 * - Whether a reply carries "media" is not documented, so ownsComment
 *   falls back to the parent comment. Replies: only the first page. "limit" is the general Graph
 *   pagination parameter (https://developers.facebook.com/docs/graph-api/results).
 * - Moderation guide (Page access token, Standard Access for accounts we
 *   own or manage): https://developers.facebook.com/docs/instagram-platform/comment-moderation
 *
 * All of these are in the scopes of the Postiz provider
 * (instagram.provider.ts: instagram_basic, pages_show_list,
 * pages_read_engagement, instagram_manage_comments), so no patch.
 *
 * Token: Integration.token of "instagram" is "<page token>___<user token>"
 * (fetchPageInformation). Like comment() and analytics() of the Postiz
 * provider, every call uses the Page token. The token goes in the query
 * (GET, DELETE) or the form body (POST), never into a log. The message of
 * a reply goes in the body, not into the URL.
 */

const GRAPH_TIMEOUT_MS = 15_000;

const MEDIA_FIELDS = 'id,permalink,timestamp,media_type,comments_count';
const COMMENT_FIELDS = 'id,text,timestamp,username,like_count,hidden';

type GraphObject = Record<string, any>;

// Instagram ids (account, media, comment) are digits only. Stricter than
// isPlatformId: a Facebook id like <page>_<post> must never reach a call
// with the Page token of this channel.
const isInstagramId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,64}$/.test(value);

// Graph answers code 100, subcode 33 for an id that does not exist or that
// this token may not see, for example a comment deleted a moment ago.
const isUnknownObject = (err: unknown) =>
  err instanceof InboxPlatformError &&
  err.details.code === 100 &&
  err.details.subcode === 33;

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : null;

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

const toReply = (row: GraphObject): InboxReply => ({
  id: String(row.id),
  text: typeof row.text === 'string' ? row.text : '',
  username: text(row.username),
  timestamp: text(row.timestamp),
  likeCount: count(row.like_count),
  hidden: row.hidden === true,
});

const rows = (value: unknown): GraphObject[] =>
  Array.isArray((value as GraphObject)?.data)
    ? (value as GraphObject).data.filter((row: GraphObject) =>
        isInstagramId(row?.id)
      )
    : [];

const toComment = (row: GraphObject): InboxComment => ({
  ...toReply(row),
  replies: rows(row.replies).map(toReply),
});

export class InstagramInbox implements YsocialInboxProvider {
  identifier = 'instagram';

  async listComments(channel: InboxChannel): Promise<InboxPost[]> {
    const media = rows(
      await this.graph('GET', channel, channel.internalId, 'media', {
        fields: MEDIA_FIELDS,
        limit: String(INBOX_POSTS_LIMIT),
      })
    );

    return Promise.all(
      media.map(async (row) => {
        const commentsCount = count(row.comments_count);
        return {
          id: String(row.id),
          permalink: text(row.permalink),
          timestamp: text(row.timestamp),
          mediaType: text(row.media_type),
          commentsCount,
          // comments_count includes replies, 0 means nothing to read.
          comments: commentsCount
            ? rows(
                await this.graph('GET', channel, row.id, 'comments', {
                  fields: `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`,
                  limit: String(INBOX_COMMENTS_LIMIT),
                })
              ).map(toComment)
            : [],
        };
      })
    );
  }

  // The comment (or the comment a reply belongs to) must be on media the
  // account of this channel created. Otherwise no write, whatever the token
  // would allow.
  async ownsComment(channel: InboxChannel, commentId: string) {
    if (!isInstagramId(commentId)) {
      return false;
    }
    let comment: GraphObject;
    try {
      comment = await this.graph('GET', channel, commentId, undefined, {
        fields: 'id,media,parent_id',
      });
    } catch (err) {
      if (isUnknownObject(err)) {
        return false;
      }
      throw err;
    }
    let mediaId = comment?.media?.id;
    if (!isInstagramId(mediaId) && isInstagramId(comment?.parent_id)) {
      const parent = await this.graph(
        'GET',
        channel,
        comment.parent_id,
        undefined,
        { fields: 'id,media' }
      );
      mediaId = parent?.media?.id;
    }
    if (!isInstagramId(mediaId)) {
      return false;
    }

    const media = await this.graph('GET', channel, mediaId, undefined, {
      fields: 'id,owner',
    });
    return media?.owner?.id === channel.internalId;
  }

  async reply(channel: InboxChannel, commentId: string, message: string) {
    const result = await this.graph('POST', channel, commentId, 'replies', {
      message,
    });
    return { id: isInstagramId(result?.id) ? result.id : null };
  }

  async hide(channel: InboxChannel, commentId: string, hide: boolean) {
    this.expectSuccess(
      await this.graph('POST', channel, commentId, undefined, {
        hide: String(hide),
      })
    );
  }

  async remove(channel: InboxChannel, commentId: string) {
    this.expectSuccess(
      await this.graph('DELETE', channel, commentId, undefined, {})
    );
  }

  private expectSuccess(result: GraphObject) {
    if (result?.success !== true) {
      throw new InboxPlatformError({
        unavailable: false,
        status: 200,
        reason: 'Die Plattform hat den Erfolg nicht bestätigt.',
      });
    }
  }

  private async graph(
    method: 'GET' | 'POST' | 'DELETE',
    channel: InboxChannel,
    id: string,
    edge: string | undefined,
    params: Record<string, string>
  ): Promise<GraphObject> {
    if (!isInstagramId(id)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    const [accessToken] = channel.token.split('___');
    const values = new URLSearchParams({
      ...params,
      access_token: accessToken,
    });
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}${
      edge ? `/${edge}` : ''
    }`;

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

    const body: GraphObject | undefined = await res
      .json()
      .catch(() => undefined);
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
  }
}
