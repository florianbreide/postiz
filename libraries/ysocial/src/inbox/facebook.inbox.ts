import {
  INBOX_COMMENTS_LIMIT,
  INBOX_POSTS_LIMIT,
  InboxChannel,
  InboxComment,
  InboxPost,
  InboxReply,
  YsocialInboxProvider,
} from './inbox.rules';
import {
  count,
  expectSuccess,
  GraphObject,
  metaGraph,
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
 *   permalink_url, status_type.
 *   https://developers.facebook.com/docs/graph-api/reference/page/published_posts
 *   https://developers.facebook.com/docs/graph-api/reference/page-post
 * - GET /{page-post-id}/comments: "the same permissions required to view the
 *   parent object". Reading the Page feed needs pages_read_engagement and
 *   pages_read_user_content, and a Page token of a person with a task on
 *   the Page. Comment IDs only with the task MODERATE. filter=toplevel
 *   (default) gives top-level comments, summary=true the total_count of
 *   them, order=reverse_chronological newest first.
 *   https://developers.facebook.com/docs/graph-api/reference/object/comments
 *   https://developers.facebook.com/docs/graph-api/reference/page/feed
 * - Comment fields message, from (name and Page-scoped id), created_time:
 *   Pages API guide "Comments and @mentions". like_count, comment_count,
 *   parent and the edge comments (replies): Comment reference. is_hidden is
 *   documented as the update parameter ("Only applicable to Page
 *   comments"), not in the current field list of the reference: on staging
 *   (README, ungeprüft).
 *   https://developers.facebook.com/documentation/pages-api/comments-mentions
 *   https://developers.facebook.com/docs/graph-api/reference/comment
 * - POST /{comment-id}/comments with message: reply as the Page, Page token
 *   of a person with the task MODERATE, pages_manage_engagement.
 *   https://developers.facebook.com/docs/graph-api/reference/object/comments
 * - POST /{comment-id} with is_hidden=true|false, DELETE /{comment-id}:
 *   answer {"success": true}. pages_manage_engagement ("create, edit and
 *   delete comments posted on the Page"), pages_read_user_content ("delete
 *   user comments on Page posts"), Permissions Reference.
 *   https://developers.facebook.com/docs/graph-api/reference/comment
 *   https://developers.facebook.com/docs/permissions
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
 * on a comment the read of this channel lists: top-level comments and their
 * replies under the latest posts of the Page.
 */

const POST_FIELDS = 'id,permalink_url,created_time,status_type';
const COMMENT_FIELDS = 'id,message,from,created_time,like_count,is_hidden';

// Page ids are digits only. Posts and comments of a Page are
// <digits>_<digits>. No "/" or "." that could point a call at another node.
const isPageId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,64}$/.test(value);

const isFacebookId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && /^\d+(_\d+)?$/.test(value);

// from.name only, never the Page-scoped id of the person.
const toReply = (row: GraphObject): InboxReply => ({
  id: String(row.id),
  text: typeof row.message === 'string' ? row.message : '',
  username: text(row.from?.name),
  timestamp: text(row.created_time),
  likeCount: count(row.like_count),
  hidden: row.is_hidden === true,
});

const rows = (value: unknown): GraphObject[] =>
  Array.isArray((value as GraphObject)?.data)
    ? (value as GraphObject).data.filter((row: GraphObject) =>
        isFacebookId(row?.id)
      )
    : [];

const toComment = (row: GraphObject): InboxComment => ({
  ...toReply(row),
  replies: rows(row.comments).map(toReply),
});

export class FacebookInbox implements YsocialInboxProvider {
  identifier = 'facebook';

  async listComments(channel: InboxChannel): Promise<InboxPost[]> {
    const posts = rows(
      await this.graph(
        'GET',
        channel,
        this.pageId(channel),
        'published_posts',
        {
          fields: POST_FIELDS,
          limit: String(INBOX_POSTS_LIMIT),
        }
      )
    );

    return Promise.all(
      posts.map(async (row) => {
        // Unlike Instagram, a Page post has no comment count field. The
        // summary of the comments edge counts top-level comments only.
        const comments = await this.graph('GET', channel, row.id, 'comments', {
          fields: `${COMMENT_FIELDS},comments{${COMMENT_FIELDS}}`,
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
          comments: rows(comments).map(toComment),
        };
      })
    );
  }

  // The comment must be in what the read of this channel lists: under one of
  // the latest posts of the Page, top level or one of its replies.
  // Otherwise no write, whatever the token would allow.
  async ownsComment(channel: InboxChannel, commentId: string) {
    if (!isFacebookId(commentId)) {
      return false;
    }
    const posts = await this.listComments(channel);
    return posts.some((post) =>
      post.comments.some(
        (comment) =>
          comment.id === commentId ||
          comment.replies.some((reply) => reply.id === commentId)
      )
    );
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

  // The Page of the channel itself (meta.graph.ts).
  async webhookSubscription(channel: InboxChannel) {
    return pageWebhookSubscription(channel.token, this.pageId(channel));
  }

  async subscribeWebhooks(channel: InboxChannel) {
    return subscribePageWebhooks(channel.token, this.pageId(channel));
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
    params: Record<string, string>
  ): Promise<GraphObject> {
    if (!isFacebookId(id)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    return metaGraph(
      method,
      channel.token,
      edge ? `${id}/${edge}` : id,
      params
    );
  }
}
