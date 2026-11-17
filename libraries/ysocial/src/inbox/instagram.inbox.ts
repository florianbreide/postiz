import {
  INBOX_COMMENTS_LIMIT,
  INBOX_POSTS_LIMIT,
  INBOX_READ_BUDGET_MS,
  InboxCapabilities,
  InboxChannel,
  InboxComment,
  InboxItem,
  InboxItemPost,
  InboxItemsPage,
  InboxPost,
  InboxReply,
  InboxUsageMeter,
  InboxWindow,
  YsocialInboxProvider,
} from './inbox.rules';
import {
  afterCursor,
  beforePostWindow,
  count,
  expectSuccess,
  GraphObject,
  hasMore,
  inPostWindow,
  isUnknownObject,
  metaGraph,
  newSince,
  pageWebhookSubscription,
  subscribePageWebhooks,
  text,
} from './meta.graph';

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
 * - Window (PR 73): GET /{ig-user-id}/media returns "the most recently
 *   created media", read from the newest back with cursors. Comments of a
 *   media: "Returns a maximum of 50 comments per query", "reverse
 *   chronological order by default", "Comments cannot be filtered by
 *   timestamp", and the comments edge is no public edge, so no field
 *   expansion on media: one call per media with comments. Replies "unless
 *   you use field expansion to request the replies field".
 *   https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
 * - Liking a comment as the account: no endpoint (IG Comment, Replies), so
 *   capabilities.like is false (W69).
 * - Own comments: the field user is "ID of IG User who created the IG
 *   Comment. Only returned if the app user created the IG Comment". from.id
 *   is the Instagram-scoped id of the author, not comparable with the
 *   account id. So fromOwner is user.id equal to the account of the channel
 *   (with the Page token, ungeprüft: on staging, README).
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
 *
 * All of these are in the scopes of the Postiz provider
 * (instagram.provider.ts: instagram_basic, pages_show_list,
 * pages_read_engagement, instagram_manage_comments), so no patch.
 *
 * Token: Integration.token of "instagram" is "<page token>___<user token>"
 * (fetchPageInformation). Like comment() and analytics() of the Postiz
 * provider, every call uses the Page token (meta.graph.ts).
 */

const MEDIA_FIELDS = 'id,permalink,timestamp,media_type,comments_count';
const COMMENT_FIELDS = 'id,text,timestamp,username,like_count,hidden,user';

// Instagram ids (account, media, comment) are digits only. Stricter than
// isPlatformId: a Facebook id like <page>_<post> must never reach a call
// with the Page token of this channel.
const isInstagramId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,64}$/.test(value);

// fromOwner: written by the account of the channel (field user).
const toReply = (row: GraphObject, accountId: string): InboxReply => ({
  id: String(row.id),
  text: typeof row.text === 'string' ? row.text : '',
  username: text(row.username),
  timestamp: text(row.timestamp),
  likeCount: count(row.like_count),
  hidden: row.hidden === true,
  fromOwner: String(row.user?.id ?? '') === accountId,
});

const rows = (value: unknown): GraphObject[] =>
  Array.isArray((value as GraphObject)?.data)
    ? (value as GraphObject).data.filter((row: GraphObject) =>
        isInstagramId(row?.id)
      )
    : [];

const toComment = (row: GraphObject, accountId: string): InboxComment => ({
  ...toReply(row, accountId),
  replies: rows(row.replies).map((reply) => toReply(reply, accountId)),
});

const THREAD_FIELDS = `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`;

const toItem = (
  row: GraphObject,
  accountId: string,
  postId: string,
  parentId: string | null
): InboxItem => ({ ...toReply(row, accountId), postId, parentId });

// A top-level comment and its replies, flat.
const threadItems = (
  comment: GraphObject,
  accountId: string,
  postId: string
): InboxItem[] => [
  toItem(comment, accountId, postId, null),
  ...rows(comment.replies).map((reply) =>
    toItem(reply, accountId, postId, String(comment.id))
  ),
];

const toItemPost = (row: GraphObject, truncated: boolean): InboxItemPost => ({
  id: String(row.id),
  permalink: text(row.permalink),
  timestamp: text(row.timestamp),
  mediaType: text(row.media_type),
  commentsCount: count(row.comments_count),
  truncated,
});

export class InstagramInbox implements YsocialInboxProvider {
  identifier = 'instagram';
  capabilities: InboxCapabilities = {
    reply: true,
    hide: true,
    delete: true,
    like: false,
    realtime: false,
  };
  // Wall clock for the read budget, set in tests.
  protected clock = () => Date.now();

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
                  fields: THREAD_FIELDS,
                  limit: String(INBOX_COMMENTS_LIMIT),
                })
              ).map((comment) => toComment(comment, channel.internalId))
            : [],
        };
      })
    );
  }

  // Comments and replies of the media in the window, newest media first
  // ("the most recently created media"), so the first older media ends it.
  // A page starts only when the time of the page before still fits into the
  // budget; a cursor that comes again ends the read.
  async listItems(
    channel: InboxChannel,
    window: InboxWindow,
    usage: InboxUsageMeter
  ): Promise<InboxItemsPage> {
    const started = this.clock();
    const seen = new Set<string>();
    const posts: InboxItemPost[] = [];
    const items: InboxItem[] = [];
    let cursor = window.cursor;
    let lastPageMs = 0;
    for (let read = 0; ; read++) {
      if (read && this.clock() - started + lastPageMs > INBOX_READ_BUDGET_MS) {
        return { posts, items, nextCursor: cursor };
      }
      const pageStarted = this.clock();
      const page = await this.graph(
        'GET',
        channel,
        channel.internalId,
        'media',
        {
          fields: MEDIA_FIELDS,
          limit: String(INBOX_POSTS_LIMIT),
          ...(cursor ? { after: cursor } : {}),
        },
        usage
      );

      const media: GraphObject[] = [];
      let ended = false;
      for (const row of rows(page)) {
        if (beforePostWindow(row.timestamp, window)) {
          ended = true;
          break;
        }
        if (inPostWindow(row.timestamp, window)) {
          media.push(row);
        }
      }

      const threads = await Promise.all(
        media.map((row) => this.mediaThreads(channel, row, usage))
      );
      lastPageMs = this.clock() - pageStarted;
      threads.forEach(({ post, comments }) => {
        posts.push(post);
        for (const comment of comments) {
          items.push(
            ...threadItems(comment, channel.internalId, post.id).filter(
              (item) => newSince(item.timestamp, window.since)
            )
          );
        }
      });

      cursor = ended ? null : afterCursor(page);
      if (!cursor || seen.has(cursor) || !rows(page).length) {
        return { posts, items, nextCursor: null };
      }
      seen.add(cursor);
    }
  }

  // The comment with its top-level comment and the replies, only on media
  // the account of this channel created (as ownsComment). postId is not
  // needed: the comment leads to its media.
  async getConversation(
    channel: InboxChannel,
    commentId: string,
    usage: InboxUsageMeter
  ) {
    const located = await this.locate(
      channel,
      commentId,
      `owner,${MEDIA_FIELDS}`,
      usage
    );
    if (!located) {
      return null;
    }
    const accountId = channel.internalId;
    const top = await this.graph(
      'GET',
      channel,
      located.topId,
      undefined,
      { fields: THREAD_FIELDS },
      usage
    );
    if (!isInstagramId(top?.id)) {
      return { post: toItemPost(located.media, false), items: [] };
    }

    const items = threadItems(top, accountId, located.mediaId);
    // A reply beyond the first page of replies: on its own.
    if (!items.some((item) => item.id === commentId)) {
      const own = await this.graph(
        'GET',
        channel,
        commentId,
        undefined,
        { fields: COMMENT_FIELDS },
        usage
      );
      if (String(own?.id) === commentId) {
        items.push(toItem(own, accountId, located.mediaId, located.topId));
      }
    }
    // truncated: here the replies of this thread.
    return {
      post: toItemPost(located.media, hasMore(top.replies)),
      items,
    };
  }

  // The comment (or the comment a reply belongs to) must be on media the
  // account of this channel created. Otherwise no write, whatever the token
  // would allow.
  async ownsComment(channel: InboxChannel, commentId: string) {
    return !!(await this.locate(channel, commentId, 'owner'));
  }

  // Instagram has no endpoint to like a comment (W69). The service checks
  // capabilities.like before, this is the second line.
  async like() {
    throw new Error('ysocial inbox: like is not supported on instagram');
  }

  // Media and top-level comment of a comment of this account, null if it
  // is unknown or on media of another account.
  private async locate(
    channel: InboxChannel,
    commentId: string,
    mediaFields: string,
    usage?: InboxUsageMeter
  ): Promise<{ mediaId: string; topId: string; media: GraphObject } | null> {
    if (!isInstagramId(commentId)) {
      return null;
    }
    let comment: GraphObject;
    try {
      comment = await this.graph(
        'GET',
        channel,
        commentId,
        undefined,
        { fields: 'id,media,parent_id' },
        usage
      );
    } catch (err) {
      if (isUnknownObject(err)) {
        return null;
      }
      throw err;
    }
    let mediaId = comment?.media?.id;
    const topId = isInstagramId(comment?.parent_id)
      ? comment.parent_id
      : commentId;
    if (!isInstagramId(mediaId) && isInstagramId(comment?.parent_id)) {
      const parent = await this.graph(
        'GET',
        channel,
        comment.parent_id,
        undefined,
        { fields: 'id,media' },
        usage
      );
      mediaId = parent?.media?.id;
    }
    if (!isInstagramId(mediaId)) {
      return null;
    }

    const media = await this.graph(
      'GET',
      channel,
      mediaId,
      undefined,
      { fields: mediaFields },
      usage
    );
    return media?.owner?.id === channel.internalId
      ? { mediaId, topId, media }
      : null;
  }

  // The comments of one media with their replies (first page each).
  private async mediaThreads(
    channel: InboxChannel,
    row: GraphObject,
    usage: InboxUsageMeter
  ): Promise<{ post: InboxItemPost; comments: GraphObject[] }> {
    // comments_count includes replies, 0 means nothing to read.
    if (!count(row.comments_count)) {
      return { post: toItemPost(row, false), comments: [] };
    }
    const edge = await this.graph(
      'GET',
      channel,
      row.id,
      'comments',
      { fields: THREAD_FIELDS, limit: String(INBOX_COMMENTS_LIMIT) },
      usage
    );
    const comments = rows(edge);
    return {
      post: toItemPost(
        row,
        hasMore(edge) || comments.some((comment) => hasMore(comment.replies))
      ),
      comments,
    };
  }

  async reply(channel: InboxChannel, commentId: string, message: string) {
    const result = await this.graph('POST', channel, commentId, 'replies', {
      message,
    });
    return { id: isInstagramId(result?.id) ? result.id : null };
  }

  async hide(channel: InboxChannel, commentId: string, hide: boolean) {
    expectSuccess(
      await this.graph('POST', channel, commentId, undefined, {
        hide: String(hide),
      })
    );
  }

  async remove(channel: InboxChannel, commentId: string) {
    expectSuccess(
      await this.graph('DELETE', channel, commentId, undefined, {})
    );
  }

  // Comment webhooks of Instagram come through the linked Page: our app has
  // to be on it (meta.graph.ts). The Page token stands for that Page, so
  // "me" is the Page. The field comments itself is set in the App Dashboard.
  async webhookSubscription(channel: InboxChannel) {
    const [accessToken] = channel.token.split('___');
    return pageWebhookSubscription(accessToken, 'me');
  }

  async subscribeWebhooks(channel: InboxChannel) {
    const [accessToken] = channel.token.split('___');
    return subscribePageWebhooks(accessToken, 'me');
  }

  private async graph(
    method: 'GET' | 'POST' | 'DELETE',
    channel: InboxChannel,
    id: string,
    edge: string | undefined,
    params: Record<string, string>,
    usage?: InboxUsageMeter
  ): Promise<GraphObject> {
    if (!isInstagramId(id)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    const [accessToken] = channel.token.split('___');
    return metaGraph(
      method,
      accessToken,
      edge ? `${id}/${edge}` : id,
      params,
      usage
    );
  }
}
