/**
 * Which answer of postAnalytics means "the post exists" and which "it does
 * not", per provider (PLAN 3.3 PR 17, E22, R22).
 *
 * No Postiz provider can fetch a single post (W34). postAnalytics reads the
 * metrics of one post and is there for facebook and instagram. Both swallow
 * every Graph error and return an empty list. So a list with at least one
 * metric means "exists", an empty list means "not found". An empty list also
 * comes back for a revoked token. That is wanted: a post the platform does
 * not show with the stored token needs a look either way.
 *
 * Everything not in this table is "nicht prüfbar", which is no alarm.
 * Phase 1 arms only facebook and instagram (R22).
 */

export type PlatformAnswer = 'found' | 'not_found';

export interface StoredPostForCheck {
  releaseId: string;
  settings?: string | null;
}

export interface PostVerificationRule {
  // For the table in the README: what "exists" and "missing" look like.
  exists: string;
  missing: string;
  // Reason why this stored post cannot be checked, undefined if it can.
  cannotCheck(post: StoredPostForCheck): string | undefined;
  classify(result: unknown): PlatformAnswer;
}

const hasMetrics = (result: unknown): PlatformAnswer =>
  Array.isArray(result) && result.length > 0 ? 'found' : 'not_found';

const postType = (settings?: string | null): string | undefined => {
  try {
    const value = JSON.parse(settings || '{}');
    return typeof value?.post_type === 'string' ? value.post_type : undefined;
  } catch (err) {
    return undefined;
  }
};

const instagram: PostVerificationRule = {
  exists: 'Liste mit mindestens einer Kennzahl (views, reach, …)',
  missing: 'leere Liste',
  // Stories have other metrics, the request fails and the list is empty.
  cannotCheck: (post) =>
    postType(post.settings) === 'story'
      ? 'Instagram-Story: postAnalytics liefert dafür keine Kennzahlen.'
      : undefined,
  classify: hasMetrics,
};

export const POST_VERIFICATION_RULES: Record<string, PostVerificationRule> = {
  facebook: {
    exists: 'Liste mit mindestens einer Kennzahl (Impressions, Reactions, …)',
    missing: 'leere Liste',
    // Feed posts are stored as {pageId}_{postId}. A bare id is a video, reel
    // or story: their edge answers empty for fresh and for missing posts.
    cannotCheck: (post) =>
      post.releaseId.includes('_')
        ? undefined
        : 'Facebook-Video, Reel oder Story: postAnalytics unterscheidet dort nicht zwischen neu und fehlend.',
    classify: hasMetrics,
  },
  instagram,
  'instagram-standalone': instagram,
};

export const ruleFor = (providerIdentifier: string) =>
  POST_VERIFICATION_RULES[providerIdentifier];
