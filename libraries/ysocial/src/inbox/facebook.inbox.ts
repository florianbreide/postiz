import {
  INBOX_COMMENTS_LIMIT,
  INBOX_FACEBOOK_POSTS_PER_PAGE,
  INBOX_POSTS_LIMIT,
  INBOX_READ_BUDGET_MS,
  INBOX_REPLIES_LIMIT,
  InboxCapabilities,
  InboxChannel,
  InboxComment,
  InboxItem,
  InboxItemPost,
  InboxItemsPage,
  InboxOwnershipUnknownError,
  InboxPost,
  InboxReply,
  InboxUsageMeter,
  InboxWindow,
  inboxWindow,
  mentionNames,
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
 * Inbox for the Postiz provider "facebook" (Facebook Page, graph.facebook.com,
 * same Graph version as Postiz).
 *
 * Endpoints and permissions, official Meta reference (read 17.11.2026):
 * - GET /{page-id}/published_posts: the posts of the Page itself, no visitor
 *   posts. At most 100 per query. Page post fields id, created_time,
 *   permalink_url, status_type, from. "This endpoint has no parameters": no
 *   since. The posts come "in a ranking", not strictly by date, so the
 *   window is read from the start with cursors, and an older post on the
 *   way (pinned, highly ranked) does not end it.
 *   https://developers.facebook.com/docs/graph-api/reference/page/published_posts
 *   https://developers.facebook.com/docs/graph-api/reference/page-post
 * - GET /{page-post-id}/comments: "the same permissions required to view the
 *   parent object". Reading the Page feed needs pages_read_engagement and
 *   pages_read_user_content, and a Page token of a person with a task on
 *   the Page. Comment IDs only with the task MODERATE. filter=toplevel
 *   (default) gives top-level comments, oldest first; filter=stream all
 *   levels, oldest first. order reverse_chronological is documented as a
 *   field of summary only.
 *   https://developers.facebook.com/docs/graph-api/reference/object/comments
 *   https://developers.facebook.com/docs/graph-api/reference/page/feed
 * - Field expansion: nested edges with .limit(n) in one call ("no limitation
 *   to the amount of nesting"). Other modifiers inside an expansion are not
 *   documented, so the nested comments and replies come oldest first. A post
 *   or a comment with more than one page is read again on its own, newest
 *   first (ungeprüft, README).
 *   https://developers.facebook.com/docs/graph-api/guides/field-expansion
 * - Comment fields message, from (name and Page-scoped id of "the person or
 *   Page who commented"), created_time: Pages API guide "Comments and
 *   @mentions". like_count, comment_count, parent and the edge comments
 *   (replies): Comment reference. is_hidden is documented as the update
 *   parameter ("Only applicable to Page comments"), not in the current field
 *   list of the reference: on staging (README, ungeprüft). That a comment of
 *   the Page carries the Page id in from.id is not stated: on staging.
 *   https://developers.facebook.com/documentation/pages-api/comments-mentions
 *   https://developers.facebook.com/docs/graph-api/reference/comment
 * - message_tags (the profiles tagged in message): not in the field list of
 *   the reference read 17.11.2026, but in the Comment object of Meta's
 *   Business SDK as list<EntityAtTextRange> with id, name, type, offset and
 *   length. name, offset and length are read, only name and the tagged part
 *   of the text leave the fork (W76): on staging (README, ungeprüft).
 *   https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/comment.py
 * - POST /{comment-id}/comments with message: reply as the Page, Page token
 *   of a person with the task MODERATE, pages_manage_engagement.
 *   https://developers.facebook.com/docs/graph-api/reference/object/comments
 * - POST /{comment-id} with is_hidden=true|false, DELETE /{comment-id}:
 *   answer {"success": true}. pages_manage_engagement ("create, edit and
 *   delete comments posted on the Page"), pages_read_user_content ("delete
 *   user comments on Page posts"), Permissions Reference.
 *   https://developers.facebook.com/docs/graph-api/reference/comment
 *   https://developers.facebook.com/docs/permissions
 * - POST /{comment-id}/likes (like as the Page): Page token of a person with
 *   the task CREATE_CONTENT, pages_manage_engagement, "the Page must also be
 *   able to like the object". DELETE /{comment-id}/likes: task MODERATE, "a
 *   user or Page can only delete their own likes". Both answer
 *   {"success": true}.
 *   https://developers.facebook.com/docs/graph-api/reference/object/likes
 *
 * pages_show_list, pages_read_engagement and pages_manage_engagement are in
 * the scopes of the Postiz provider (facebook.provider.ts), and since
 * ysocial patch 4 pages_read_user_content as well (scopes/meta.scopes.ts).
 * Pages connected before that carry it only after they are connected again.
 *
 * Token: Integration.token of "facebook" is the Page token itself
 * (fetchPageInformation), as in comment() of the Postiz provider.
 *
 * Ownership: the Comment reference documents no field that leads from a
 * comment to its post, only "parent" for a reply. So a write is allowed only
 * on a comment found under a post of this Page: with postId (the hub knows it
 * from items) under that post, after from.id of the post is the Page;
 * without it under the posts of the last 30 days and at least the latest
 * INBOX_POSTS_LIMIT posts, which the demo shows.
 */

const POST_FIELDS = 'id,permalink_url,created_time,status_type';
const COMMENT_FIELDS =
  'id,message,from,created_time,like_count,is_hidden,message_tags';
// Top-level comments with their replies (first page of each).
const THREAD_FIELDS = `${COMMENT_FIELDS},comments.limit(${INBOX_REPLIES_LIMIT}){${COMMENT_FIELDS}}`;
// The posts of a page of the window with their comments, one call.
const WINDOW_FIELDS = `${POST_FIELDS},comments.limit(${INBOX_COMMENTS_LIMIT}){${THREAD_FIELDS}}`;
// Comments of all levels of one post when searching a comment: id and the
// comment a reply belongs to, nothing else.
const SEARCH_FIELDS = 'id,parent{id}';
const SEARCH_LIMIT = 100;
// Reading the newest replies of long threads: this many calls at once per
// post, the posts of a page run side by side.
const REPLIES_AT_ONCE = 5;

// fn over items, size at a time, results in the order of items.
const inBatches = async <T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(
      ...(await Promise.all(items.slice(start, start + size).map(fn)))
    );
  }
  return results;
};

// Page ids are digits only. Posts and comments of a Page are
// <digits>_<digits>. No "/" or "." that could point a call at another node.
const isPageId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,64}$/.test(value);

const isFacebookId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && /^\d+(_\d+)?$/.test(value);

// The part of the text a tag covers. A tag shortened to the first name
// shows only that in the text, while name stays the full name (W76).
// Assumed: Meta counts offset and length in UTF-16 units, like a JavaScript
// string (ungeprüft, README). null outside the text or when the part would
// cut a surrogate pair.
const taggedText = (message: string, tag: GraphObject) => {
  const offset = tag?.offset;
  const length = tag?.length;
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 1 ||
    offset + length > message.length
  ) {
    return null;
  }
  const part = message.slice(offset, offset + length);
  return /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part) ? null : part;
};

// from.name only, never the Page-scoped id of the person. fromOwner: written
// by the Page of the channel. mentions: per tag of message_tags its name and
// the part of the text it covers, never an id.
const toReply = (row: GraphObject, pageId: string): InboxReply => {
  const message = typeof row.message === 'string' ? row.message : '';
  return {
    id: String(row.id),
    text: message,
    username: text(row.from?.name),
    timestamp: text(row.created_time),
    likeCount: count(row.like_count),
    hidden: row.is_hidden === true,
    fromOwner: String(row.from?.id ?? '') === pageId,
    mentions: mentionNames(
      Array.isArray(row.message_tags)
        ? row.message_tags.flatMap((tag: GraphObject) => [
            tag?.name,
            taggedText(message, tag),
          ])
        : []
    ),
  };
};

const rows = (value: unknown): GraphObject[] =>
  Array.isArray((value as GraphObject)?.data)
    ? (value as GraphObject).data.filter((row: GraphObject) =>
        isFacebookId(row?.id)
      )
    : [];

const toComment = (row: GraphObject, pageId: string): InboxComment => ({
  ...toReply(row, pageId),
  replies: rows(row.comments).map((reply) => toReply(reply, pageId)),
});

const toItem = (
  row: GraphObject,
  pageId: string,
  postId: string,
  parentId: string | null
): InboxItem => ({ ...toReply(row, pageId), postId, parentId });

// A top-level comment and its replies, flat.
const threadItems = (
  comment: GraphObject,
  pageId: string,
  postId: string
): InboxItem[] => [
  toItem(comment, pageId, postId, null),
  ...rows(comment.comments).map((reply) =>
    toItem(reply, pageId, postId, String(comment.id))
  ),
];

const toItemPost = (row: GraphObject, truncated: boolean): InboxItemPost => ({
  id: String(row.id),
  permalink: text(row.permalink_url),
  timestamp: text(row.created_time),
  mediaType: text(row.status_type),
  // A Page post has no comment count field.
  commentsCount: null,
  truncated,
});

// A post of the window with its comments: the edge of the page read, or the
// newest comments read on their own when the post has more than one page.
interface WindowPost {
  post: InboxItemPost;
  comments: GraphObject[];
}

interface ReadOptions {
  // Searching a comment: no cursor back, out of time is
  // InboxOwnershipUnknownError.
  search?: boolean;
  // Posts read at least, also older than the window (the demo shows the
  // latest INBOX_POSTS_LIMIT posts).
  minPosts?: number;
}

export class FacebookInbox implements YsocialInboxProvider {
  identifier = 'facebook';
  capabilities: InboxCapabilities = {
    reply: true,
    hide: true,
    delete: true,
    like: true,
    realtime: false,
  };
  // Wall clock for the read budget, set in tests.
  protected clock = () => Date.now();

  async listComments(channel: InboxChannel): Promise<InboxPost[]> {
    const pageId = this.pageId(channel);
    const posts = rows(
      await this.graph('GET', channel, pageId, 'published_posts', {
        fields: POST_FIELDS,
        limit: String(INBOX_POSTS_LIMIT),
      })
    );

    return Promise.all(
      posts.map(async (row) => {
        // Unlike Instagram, a Page post has no comment count field. The
        // summary of the comments edge counts top-level comments only.
        const comments = await this.graph('GET', channel, row.id, 'comments', {
          fields: THREAD_FIELDS,
          filter: 'toplevel',
          order: 'reverse_chronological',
          summary: 'true',
          limit: String(INBOX_COMMENTS_LIMIT),
        });
        return {
          id: String(row.id),
          permalink: text(row.permalink_url),
          timestamp: text(row.created_time),
          mediaType: text(row.status_type),
          commentsCount: count(comments?.summary?.total_count),
          // The newest replies of a long thread, as the check before a write
          // sees them.
          comments: (
            await inBatches(rows(comments), REPLIES_AT_ONCE, (comment) =>
              this.newestReplies(channel, comment)
            )
          ).map((comment) => toComment(comment, pageId)),
        };
      })
    );
  }

  async listItems(
    channel: InboxChannel,
    window: InboxWindow,
    usage: InboxUsageMeter
  ): Promise<InboxItemsPage> {
    const pageId = this.pageId(channel);
    const posts: InboxItemPost[] = [];
    const items: InboxItem[] = [];
    const nextCursor = await this.readWindow(
      channel,
      window,
      usage,
      ({ post, comments }) => {
        posts.push(post);
        for (const comment of comments) {
          items.push(
            ...threadItems(comment, pageId, post.id).filter((item) =>
              newSince(item.timestamp, window.since)
            )
          );
        }
        return false;
      }
    );
    return { posts, items, nextCursor };
  }

  // With postId only under that post, without it under the posts of the
  // last 30 days and at least the latest INBOX_POSTS_LIMIT posts. The same
  // read decides about writes (ownsComment).
  async getConversation(
    channel: InboxChannel,
    commentId: string,
    usage: InboxUsageMeter,
    postId?: string | null
  ) {
    if (!isFacebookId(commentId)) {
      return null;
    }
    if (postId) {
      return this.conversationInPost(channel, commentId, postId, usage);
    }

    const pageId = this.pageId(channel);
    const result: { found?: { post: InboxItemPost; items: InboxItem[] } } = {};
    await this.readWindow(
      channel,
      this.recentWindow(),
      usage,
      ({ post, comments }) => {
        const thread = comments.find(
          (comment) =>
            String(comment.id) === commentId ||
            rows(comment.comments).some((reply) => reply.id === commentId)
        );
        if (thread) {
          result.found = { post, items: threadItems(thread, pageId, post.id) };
        }
        return !!thread;
      },
      { search: true, minPosts: INBOX_POSTS_LIMIT }
    );
    return result.found ?? null;
  }

  // Otherwise no write, whatever the token would allow. With postId the
  // post check and finding the comment under it are enough.
  async ownsComment(
    channel: InboxChannel,
    commentId: string,
    postId?: string | null
  ) {
    const usage = new InboxUsageMeter();
    if (postId) {
      return (
        isFacebookId(commentId) &&
        !!(await this.locateInPost(channel, commentId, postId, usage))
      );
    }
    return !!(await this.getConversation(channel, commentId, usage));
  }

  async reply(channel: InboxChannel, commentId: string, message: string) {
    const result = await this.graph('POST', channel, commentId, 'comments', {
      message,
    });
    return { id: isFacebookId(result?.id) ? result.id : null };
  }

  async hide(channel: InboxChannel, commentId: string, hide: boolean) {
    expectSuccess(
      await this.graph('POST', channel, commentId, undefined, {
        is_hidden: String(hide),
      })
    );
  }

  async remove(channel: InboxChannel, commentId: string) {
    expectSuccess(
      await this.graph('DELETE', channel, commentId, undefined, {})
    );
  }

  async like(channel: InboxChannel, commentId: string, like: boolean) {
    expectSuccess(
      await this.graph(
        like ? 'POST' : 'DELETE',
        channel,
        commentId,
        'likes',
        {}
      )
    );
  }

  // The Page of the channel itself (meta.graph.ts).
  async webhookSubscription(channel: InboxChannel) {
    return pageWebhookSubscription(channel.token, this.pageId(channel));
  }

  async subscribeWebhooks(channel: InboxChannel) {
    return subscribePageWebhooks(channel.token, this.pageId(channel));
  }

  // The posts of the last 30 days.
  private recentWindow(): InboxWindow {
    return inboxWindow({}, new Date(this.clock()));
  }

  /**
   * The comment under the post the hub named, with its top-level comment and
   * the replies (locateInPost). A reply to a reply leads up to its top-level
   * comment, at most two steps (ungeprüft whether Meta nests that deep).
   */
  private async conversationInPost(
    channel: InboxChannel,
    commentId: string,
    postId: string,
    usage: InboxUsageMeter
  ) {
    const pageId = this.pageId(channel);
    const located = await this.locateInPost(channel, commentId, postId, usage);
    if (!located) {
      return null;
    }

    let top = await this.graph(
      'GET',
      channel,
      located.topId,
      undefined,
      { fields: `${THREAD_FIELDS},parent{id}` },
      usage
    );
    for (let up = 0; up < 2 && isFacebookId(top?.parent?.id); up++) {
      top = await this.graph(
        'GET',
        channel,
        top.parent.id,
        undefined,
        { fields: `${THREAD_FIELDS},parent{id}` },
        usage
      );
    }
    if (!isFacebookId(top?.id)) {
      return null;
    }
    const thread = await this.newestReplies(channel, top, usage);
    const topId = String(thread.id);

    const items = threadItems(thread, pageId, postId);
    // A reply on none of the pages read of its thread: on its own.
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
        items.push(toItem(own, pageId, postId, topId));
      }
    }
    return {
      post: toItemPost(located.post, hasMore(thread.comments)),
      items,
    };
  }

  /**
   * The post must be a post of this Page: id <page-id>_…, and from.id of the
   * post the Page (Page post reference). Then the comments of all levels of
   * the post, newest first, page by page, until the comment is there. A page
   * starts only while the budget lasts, counted from the start. null: not a
   * comment under this post of the Page.
   */
  private async locateInPost(
    channel: InboxChannel,
    commentId: string,
    postId: string,
    usage: InboxUsageMeter
  ): Promise<{ post: GraphObject; topId: string } | null> {
    const started = this.clock();
    const pageId = this.pageId(channel);
    if (!isFacebookId(postId) || !postId.startsWith(`${pageId}_`)) {
      return null;
    }

    let post: GraphObject;
    try {
      post = await this.graph(
        'GET',
        channel,
        postId,
        undefined,
        { fields: `${POST_FIELDS},from` },
        usage
      );
    } catch (err) {
      if (isUnknownObject(err)) {
        return null;
      }
      throw err;
    }
    if (String(post?.id) !== postId || String(post?.from?.id) !== pageId) {
      return null;
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let lastPageMs = 0;
    for (;;) {
      if (
        cursor &&
        this.clock() - started + lastPageMs > INBOX_READ_BUDGET_MS
      ) {
        throw new InboxOwnershipUnknownError();
      }
      const pageStarted = this.clock();
      const page = await this.graph(
        'GET',
        channel,
        postId,
        'comments',
        {
          fields: SEARCH_FIELDS,
          filter: 'stream',
          // New comments are the usual target. Without effect the oldest
          // come first, as documented for stream.
          order: 'reverse_chronological',
          limit: String(SEARCH_LIMIT),
          ...(cursor ? { after: cursor } : {}),
        },
        usage
      );
      lastPageMs = this.clock() - pageStarted;

      const found = rows(page).find((row) => row.id === commentId);
      if (found) {
        return {
          post,
          topId: isFacebookId(found.parent?.id) ? found.parent.id : commentId,
        };
      }
      cursor = afterCursor(page);
      if (!cursor || seen.has(cursor) || !rows(page).length) {
        return null;
      }
      seen.add(cursor);
    }
  }

  /**
   * Reads the posts of the window page by page and hands each with its
   * comments to visit (true: stop). Returns the cursor for the next call,
   * or null at the end of the window.
   * - published_posts comes in a ranking: an older post on the way is
   *   skipped, the window ends after a page with no post at or after
   *   postsFrom (and not before minPosts posts).
   * - A page starts only when the time of the page before still fits into
   *   the budget. The first page always runs.
   * - A cursor that comes again or a page without posts ends the read.
   */
  private async readWindow(
    channel: InboxChannel,
    window: InboxWindow,
    usage: InboxUsageMeter,
    visit: (post: WindowPost) => boolean,
    { search = false, minPosts = 0 }: ReadOptions = {}
  ): Promise<string | null> {
    const started = this.clock();
    const seen = new Set<string>();
    let cursor = window.cursor;
    let read = 0;
    let lastPageMs = 0;
    for (;;) {
      if (read && this.clock() - started + lastPageMs > INBOX_READ_BUDGET_MS) {
        if (search) {
          throw new InboxOwnershipUnknownError();
        }
        return cursor;
      }
      const pageStarted = this.clock();
      const page = await this.graph(
        'GET',
        channel,
        this.pageId(channel),
        'published_posts',
        {
          fields: WINDOW_FIELDS,
          limit: String(INBOX_FACEBOOK_POSTS_PER_PAGE),
          ...(cursor ? { after: cursor } : {}),
        },
        usage
      );

      const posts = rows(page);
      const visited = posts.filter(
        (row, index) =>
          inPostWindow(row.created_time, window) || read + index < minPosts
      );
      const windowPosts = await Promise.all(
        visited.map((row) => this.windowPost(channel, row, usage))
      );
      lastPageMs = this.clock() - pageStarted;
      for (const windowPost of windowPosts) {
        if (visit(windowPost)) {
          return null;
        }
      }
      read += posts.length;

      cursor = afterCursor(page);
      if (
        !cursor ||
        seen.has(cursor) ||
        !posts.length ||
        (read >= minPosts &&
          posts.every((row) => beforePostWindow(row.created_time, window)))
      ) {
        return null;
      }
      seen.add(cursor);
    }
  }

  private async windowPost(
    channel: InboxChannel,
    row: GraphObject,
    usage: InboxUsageMeter
  ): Promise<WindowPost> {
    let edge = row.comments;
    // More top-level comments than one page: the newest instead of the
    // oldest, as the demo reads them.
    if (hasMore(edge)) {
      edge = await this.graph(
        'GET',
        channel,
        row.id,
        'comments',
        {
          fields: THREAD_FIELDS,
          filter: 'toplevel',
          order: 'reverse_chronological',
          limit: String(INBOX_COMMENTS_LIMIT),
        },
        usage
      );
    }
    const comments = await inBatches(rows(edge), REPLIES_AT_ONCE, (comment) =>
      this.newestReplies(channel, comment, usage)
    );
    return {
      post: toItemPost(
        row,
        hasMore(edge) || comments.some((comment) => hasMore(comment.comments))
      ),
      comments,
    };
  }

  // Nested replies come oldest first. A thread with more than one page of
  // them gets its newest replies instead, so a new reply reaches the hub.
  private async newestReplies(
    channel: InboxChannel,
    comment: GraphObject,
    usage?: InboxUsageMeter
  ): Promise<GraphObject> {
    if (!hasMore(comment?.comments) || !isFacebookId(comment?.id)) {
      return comment;
    }
    const replies = await this.graph(
      'GET',
      channel,
      comment.id,
      'comments',
      {
        fields: COMMENT_FIELDS,
        order: 'reverse_chronological',
        limit: String(INBOX_REPLIES_LIMIT),
      },
      usage
    );
    return { ...comment, comments: replies };
  }

  private pageId(channel: InboxChannel) {
    if (!isPageId(channel.internalId)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    return channel.internalId;
  }

  private async graph(
    method: 'GET' | 'POST' | 'DELETE',
    channel: InboxChannel,
    id: string,
    edge: string | undefined,
    params: Record<string, string>,
    usage?: InboxUsageMeter
  ): Promise<GraphObject> {
    if (!isFacebookId(id)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    return metaGraph(
      method,
      channel.token,
      edge ? `${id}/${edge}` : id,
      params,
      usage
    );
  }
}
