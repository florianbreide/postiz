/**
 * Rule 2 (no post without a person's approval) inside Postiz (D15, Hub
 * infra/README.md 24). Postiz posts on its own after a repeat interval
 * ("Repeat Post", inter / intervalInDays), through an internal plug of the
 * editor (another channel shares or comments after the post) and through a
 * global plug of a channel (Plugs table, a repost or comment from n likes).
 * The fork refuses all three where they are set (YsocialAutomationMiddleware)
 * and counts what was set before (YsocialAutomationCheck).
 */

export const AUTOMATION_BLOCKED_CODE = 'automation_blocked';
export const AUTOMATION_BLOCKED_MESSAGE =
  'Wiederholungen und Plugs sind gesperrt, Posts laufen über das Studio (Regel 2).';

// Whether the settings of a post trigger an internal plug. Postiz runs one
// for every channel in plug--<plug>--integrations (PostsService
// .checkInternalPlug, every key with "plug-", split by "--"), whatever
// plug--<plug>--active says. A part named __proto__ counts as yes: a missed
// automatic post is the worse mistake.
export const hasInternalPlug = (settings: unknown) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return false;
  }
  return Object.entries(settings).some(([key, channels]) => {
    if (key.indexOf('plug-') === -1) {
      return false;
    }
    const [, name, field] = key.split('--');
    if (name === '__proto__' || field === '__proto__') {
      return true;
    }
    return (
      field === 'integrations' && Array.isArray(channels) && channels.length > 0
    );
  });
};

// The body of POST /posts and POST /public/v1/posts (CreatePostDto): a repeat
// interval above 0, or a post with an internal plug. null: allowed.
export const automatedPost = (body: unknown): 'repeat' | 'plug' | null => {
  const post = body as { inter?: unknown; posts?: unknown } | null;
  if (Number(post?.inter) > 0) {
    return 'repeat';
  }
  return Array.isArray(post?.posts) &&
    post!.posts.some((item) => hasInternalPlug(item?.settings))
    ? 'plug'
    : null;
};
