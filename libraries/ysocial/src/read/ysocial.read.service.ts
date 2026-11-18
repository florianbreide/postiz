import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { realpath, stat } from 'fs/promises';
import { resolve, sep } from 'path';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import {
  CUSTOMER_FIELDS,
  INTEGRATION_FIELDS,
  POST_FIELDS,
  YsocialReadRepository,
} from '../database/ysocial.read.repository';
import { hasInternalPlug } from '../automation/automation.rules';
import { inOwnStorage, storageLocation } from '../deletion/deletion.rules';
import { sanitizeReason } from '../events/hub.event';
import { channelFlag, ChannelRow } from '../health/channel.health';

export const POSTS_MAX_RANGE_DAYS = 31;

type PostRow = Record<string, unknown> & {
  id: string;
  organizationId: string;
  parentPostId: string | null;
  image: string | null;
  error: string | null;
  settings: string | null;
};

type MediaRow = {
  id: string;
  organizationId: string;
  path: string;
  fileSize: number;
};

// The media rows of a request by id.
type MediaSizes = Map<string, MediaRow>;

// Files above this get no sha256 (K6): the hub then does not link the post.
export const MEDIA_HASH_MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_HASH_CACHE = 500;
// Finished hashes, the most recently used last, and the runs going on.
const mediaHashes = new Map<string, string>();
const mediaHashRuns = new Map<string, Promise<string | null>>();

// The upload folder after links, once per process and folder.
const uploadBases = new Map<string, Promise<string>>();
const uploadBase = (directory: string) => {
  let base = uploadBases.get(directory);
  if (!base) {
    base = realpath(resolve(directory));
    uploadBases.set(directory, base);
    base.catch(() => uploadBases.delete(directory));
  }
  return base;
};

// A medium in the local storage of Postiz, by the same rule as the deletion
// job (storageLocation, inOwnStorage: below FRONTEND_URL/uploads/, no ..),
// and only inside UPLOAD_DIRECTORY, also after links (realpath). Cloudflare
// or a path of another place: null.
const localFileOf = async (path: string) => {
  const location = storageLocation(process.env);
  const directory = process.env.UPLOAD_DIRECTORY;
  if (
    !location ||
    location.flat ||
    !directory ||
    !inOwnStorage(path, location)
  ) {
    return null;
  }
  const [file, base] = await Promise.all([
    realpath(resolve(directory, path.slice(location.prefix.length))),
    uploadBase(directory),
  ]);
  return file.startsWith(base + sep) ? file : null;
};

// Size and time of change of a local medium, null if there is none.
const localFileInfo = async (path: string) => {
  try {
    const file = await localFileOf(path);
    const info = file ? await stat(file) : null;
    return file && info?.isFile() ? { file, info } : null;
  } catch (err) {
    return null;
  }
};

const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, {
    highWaterMark: 1 << 20,
  })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

/**
 * SHA-256 of the bytes of a medium, hex (K6), for the hub to compare a post
 * with the media of its version before it links them. null when the file is
 * not in the local storage, missing, too big or unreadable. Cached by file,
 * size and time of change (the files of Postiz do not change), the most
 * recently used kept; a run going on for the same file is shared.
 */
export const mediaSha256 = async (path: string) => {
  const local = await localFileInfo(path);
  if (!local || local.info.size > MEDIA_HASH_MAX_BYTES) {
    return null;
  }
  const key = `${local.file}:${local.info.size}:${local.info.mtimeMs}`;
  const cached = mediaHashes.get(key);
  if (cached) {
    mediaHashes.delete(key);
    mediaHashes.set(key, cached);
    return cached;
  }
  let run = mediaHashRuns.get(key);
  if (!run) {
    run = hashFile(local.file)
      .then((value) => {
        mediaHashes.set(key, value);
        if (mediaHashes.size > MEDIA_HASH_CACHE) {
          mediaHashes.delete(mediaHashes.keys().next().value!);
        }
        return value;
      })
      .catch(() => null)
      .finally(() => mediaHashRuns.delete(key));
    mediaHashRuns.set(key, run);
  }
  return run;
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
// thumbnail). Only path and type go out, and since 0.10.1 the size in bytes
// (K6): only when the row of the id in the media library belongs to the
// organization of the post and has the same path, otherwise null. The size
// is fileSize of that row; locally Postiz leaves it at 0 (only the media
// processor on Cloudflare sets it), then the size of the file. The post
// holds no type, Postiz tells a video by its extension (VideoOrImage, the
// providers).
const mediaItems = (value: string | null) => {
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
    .map((item) => item as { id?: unknown; path?: unknown } | null)
    .filter(
      (item): item is { id?: unknown; path: string } =>
        typeof item?.path === 'string' && !!item.path
    )
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : null,
      path: item.path,
    }));
};

const sizeOf = async (
  row: PostRow,
  sizes: MediaSizes,
  id: string | null,
  path: string
) => {
  const known = id ? sizes.get(id) : undefined;
  if (
    !known ||
    known.organizationId !== row.organizationId ||
    known.path !== path
  ) {
    return null;
  }
  if (known.fileSize > 0) {
    return known.fileSize;
  }
  return (await localFileInfo(path))?.info.size ?? null;
};

const media = (row: PostRow, sizes: MediaSizes) =>
  Promise.all(
    mediaItems(row.image).map(async ({ id, path }) => ({
      path,
      type: hasExtension(path, 'mp4') ? ('video' as const) : ('image' as const),
      size: await sizeOf(row, sizes, id, path),
    }))
  );

// Whether the post triggers an internal plug: another channel likes,
// reposts or comments it after the post went out (D15, PR 52 of the hub).
// Only this yes or no goes out, never the settings. Unreadable settings:
// false, the workflow of Postiz fails on them before any plug.
const plug = (value: string | null) => {
  let settings: unknown;
  try {
    settings = JSON.parse(value || '{}');
  } catch {
    return false;
  }
  return hasInternalPlug(settings);
};

const toPost = async (row: PostRow, sizes: MediaSizes) => ({
  ...pick(row, POST_FIELDS),
  image: await media(row, sizes),
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
  protected hashMedium = mediaSha256;

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
    const sizes = await this.mediaSizes(rows);
    return Promise.all(rows.map((row) => toPost(row, sizes)));
  }

  // A post with the comments after it, like Postiz reads a thread for the
  // workflow. A deleted post is not found, as in the list. hashes: with the
  // sha256 of each medium (?media=sha256, K6).
  async getPost(id: string, hashes = false) {
    const post = await this._read.getPost(id);
    if (!post) {
      throw new NotFoundException({ statusCode: 404, code: 'not_found' });
    }
    const group = await this._read.getPostGroup(
      post.organizationId,
      post.group
    );
    const comments = commentsAfter(post.id, group);
    const sizes = await this.mediaSizes([post, ...comments]);
    const [first, ...rest] = await Promise.all(
      [post, ...comments].map(async (row) => {
        const item = await toPost(row, sizes);
        return hashes ? this.withHashes(item) : item;
      })
    );
    return { ...first, comments: rest };
  }

  // One query for the media rows of all posts of a request.
  private async mediaSizes(rows: PostRow[]): Promise<MediaSizes> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          mediaItems(row.image).flatMap(({ id }) => (id ? [id] : []))
        )
      ),
    ];
    if (!ids.length) {
      return new Map();
    }
    const found = (await this._read.getMedia(ids)) as MediaRow[];
    return new Map(found.map((row) => [row.id, row]));
  }

  // sha256 of each medium, only for a single post on request (K6): the hub
  // compares them before it links a post of an admin.
  private async withHashes<T extends { image: { path: string }[] }>(post: T) {
    return {
      ...post,
      image: await Promise.all(
        post.image.map(async (item) => ({
          ...item,
          sha256: await this.hashMedium(item.path),
        }))
      ),
    };
  }
}
