import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import {
  CUSTOMER_FIELDS,
  INTEGRATION_FIELDS,
  POST_FIELDS,
  YsocialReadRepository,
} from '../database/ysocial.read.repository';
import { sanitizeReason } from '../events/hub.event';
import { channelFlag, ChannelRow } from '../health/channel.health';

export const POSTS_MAX_RANGE_DAYS = 31;

type PostRow = Record<string, unknown> & {
  id: string;
  parentPostId: string | null;
  image: string | null;
  error: string | null;
  settings: string | null;
};

// Copies only the listed fields. The selects already limit the columns,
// this keeps the response fixed even if a select changes.
const pick = <T extends Record<string, true>>(
  row: Record<string, unknown>,
  fields: T
): { [K in keyof T]: unknown } =>
  Object.fromEntries(
    Object.keys(fields).map((key) => [key, row[key] ?? null])
  ) as { [K in keyof T]: unknown };

// Postiz stores the media of a post as JSON (MediaDto: id, path, alt,
// thumbnail). Only path and type go out. The post holds no type, Postiz
// tells a video by its extension (VideoOrImage, the providers).
const media = (value: string | null) => {
  let list: unknown;
  try {
    list = JSON.parse(value || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => (item as { path?: unknown } | null)?.path)
    .filter((path): path is string => typeof path === 'string' && !!path)
    .map((path) => ({
      path,
      type: hasExtension(path, 'mp4') ? ('video' as const) : ('image' as const),
    }));
};

// Whether the post triggers an internal plug: another channel likes,
// reposts or comments it after the post went out (D15, PR 52 of the hub).
// Postiz runs one for every channel in plug--<plug>--integrations of the
// settings (PostsService.checkInternalPlug, every key with "plug-", split by
// "--"), whatever plug--<plug>--active says. Only this yes or no goes out,
// never the settings. Unreadable settings: false, the workflow of Postiz
// fails on them before any plug. A part named __proto__ counts as yes: a
// missed automatic post is the worse mistake.
const plug = (value: string | null) => {
  let settings: unknown;
  try {
    settings = JSON.parse(value || '{}');
  } catch {
    return false;
  }
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

const toPost = (row: PostRow) => ({
  ...pick(row, POST_FIELDS),
  image: media(row.image),
  error: sanitizeReason(row.error) || null,
  plug: plug(row.settings),
});

// The comments after a post in thread order. Postiz links each one to the
// one before it (parentPostId) and walks them the same way
// (PostsService.getPostsRecursively).
const commentsAfter = (id: string, group: PostRow[]) => {
  // The group comes sorted by createdAt and id. Should a post ever have two
  // children, the oldest one counts. Postiz loads childrenPost without an
  // order, so this is a fixed choice, not a copy of Postiz.
  const byParent = new Map<string | null, PostRow>();
  for (const row of group) {
    if (!byParent.has(row.parentPostId)) {
      byParent.set(row.parentPostId, row);
    }
  }
  const seen = new Set([id]);
  const comments: PostRow[] = [];
  for (
    let row = byParent.get(id);
    row && !seen.has(row.id);
    row = byParent.get(row.id)
  ) {
    seen.add(row.id);
    comments.push(row);
  }
  return comments;
};

/**
 * Read API for the hub: customers, channels and posts of Postiz with fixed
 * field lists (PLAN 3.3 PR 18, post text and media since PR 36). Read-only.
 * Nothing here logs, so the post text never reaches the log.
 */
@Injectable()
export class YsocialReadService {
  constructor(private _read: YsocialReadRepository) {}

  async getCustomers() {
    const rows = await this._read.getCustomers();
    return rows.map((row) => pick(row, CUSTOMER_FIELDS));
  }

  async getIntegrations() {
    const rows = await this._read.getIntegrations();
    return rows.map((row) => ({
      ...pick(row, INTEGRATION_FIELDS),
      // ok, refresh_needed, in_between_steps or disabled
      status: channelFlag(row as unknown as ChannelRow) || 'ok',
    }));
  }

  async getPosts(fromValue: string, toValue: string) {
    const from = new Date(fromValue);
    const to = new Date(toValue);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be ISO 8601 dates');
    }
    if (to <= from) {
      throw new BadRequestException('to must be after from');
    }
    if (
      to.getTime() - from.getTime() >
      POSTS_MAX_RANGE_DAYS * 24 * 60 * 60_000
    ) {
      throw new BadRequestException(
        `at most ${POSTS_MAX_RANGE_DAYS} days per request`
      );
    }

    const rows = await this._read.getPosts(from, to);
    return rows.map(toPost);
  }

  // A post with the comments after it, like Postiz reads a thread for the
  // workflow. A deleted post is not found, as in the list.
  async getPost(id: string) {
    const post = await this._read.getPost(id);
    if (!post) {
      throw new NotFoundException({ statusCode: 404, code: 'not_found' });
    }
    const group = await this._read.getPostGroup(
      post.organizationId,
      post.group
    );
    return {
      ...toPost(post),
      comments: commentsAfter(post.id, group).map(toPost),
    };
  }
}
