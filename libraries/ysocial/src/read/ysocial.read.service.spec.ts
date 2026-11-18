// stat of fs/promises is read-only for spyOn: wrap it, it calls the real one.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, createReadStream: jest.fn(actual.createReadStream) };
});
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, stat: jest.fn(actual.stat) };
});

import { createHash } from 'crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { YsocialReadRepository } from '../database/ysocial.read.repository';
import {
  MEDIA_HASH_MAX_BYTES,
  mediaSha256,
  YsocialReadService,
} from './ysocial.read.service';

const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const NAMES = ['FRONTEND_URL', 'UPLOAD_DIRECTORY', 'STORAGE_PROVIDER'];
const BASE = 'https://hub.example.test';
const url = (name: string) => `${BASE}/uploads/${name}`;

describe('mediaSha256 (K6)', () => {
  const saved: Record<string, string | undefined> = {};
  let directory: string;

  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
    }
    // A new folder per test: the cache is keyed by file, size and mtime.
    directory = mkdtempSync(join(tmpdir(), 'ysocial-sha-'));
    process.env.FRONTEND_URL = BASE;
    process.env.UPLOAD_DIRECTORY = directory;
    delete process.env.STORAGE_PROVIDER;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (fs.createReadStream as unknown as jest.Mock).mockReset();
    (fs.createReadStream as unknown as jest.Mock).mockImplementation(
      jest.requireActual('fs').createReadStream
    );
    (fsPromises.stat as unknown as jest.Mock).mockImplementation(
      jest.requireActual('fs/promises').stat
    );
    for (const name of NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const put = (name: string, content: string | Buffer) => {
    writeFileSync(join(directory, name), content);
    return url(name);
  };

  it('is the hex SHA-256 of the bytes of the file', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 255]);
    expect(await mediaSha256(put('a.bin', bytes))).toBe(sha(bytes));
    expect(await mediaSha256(put('b.txt', ''))).toBe(sha(''));
  });

  it('reads a file in a subfolder and takes STORAGE_PROVIDER local explicitly', async () => {
    mkdirSync(join(directory, '2026', '10'), { recursive: true });
    writeFileSync(join(directory, '2026', '10', 'x.png'), 'x');
    process.env.STORAGE_PROVIDER = 'local';
    expect(await mediaSha256(url('2026/10/x.png'))).toBe(sha('x'));
  });

  it('treats an empty STORAGE_PROVIDER as local', async () => {
    process.env.STORAGE_PROVIDER = '';
    expect(await mediaSha256(put('a.txt', 'a'))).toBe(sha('a'));
  });

  it('caches by file, size and mtime: no second read of an unchanged file', async () => {
    const path = put('c.txt', 'aaaa');
    const file = join(directory, 'c.txt');
    // A whole second: a Date cannot carry the sub-millisecond part of a mtime.
    const mtime = new Date(1_700_000_000_000);
    utimesSync(file, mtime, mtime);
    const first = await mediaSha256(path);
    expect(first).toBe(sha('aaaa'));

    // Same size, same mtime: the cache answers, the new bytes are not read.
    writeFileSync(file, 'bbbb');
    utimesSync(file, mtime, mtime);
    expect(await mediaSha256(path)).toBe(first);

    // A new mtime is a new key: read again.
    const later = new Date(mtime.getTime() + 5000);
    utimesSync(file, later, later);
    expect(await mediaSha256(path)).toBe(sha('bbbb'));

    // A new size too.
    writeFileSync(file, 'cccccc');
    utimesSync(file, later, later);
    expect(await mediaSha256(path)).toBe(sha('cccccc'));
  });

  it('keeps at most 500 hashes: the oldest one is read again', async () => {
    const first = put('first.txt', 'aaaa');
    const file = join(directory, 'first.txt');
    const mtime = new Date(1_700_000_000_000);
    utimesSync(file, mtime, mtime);
    expect(await mediaSha256(first)).toBe(sha('aaaa'));
    for (let i = 0; i < 500; i++) {
      await mediaSha256(put(`f${i}.txt`, `file ${i}`));
    }
    writeFileSync(file, 'bbbb');
    utimesSync(file, mtime, mtime);
    expect(await mediaSha256(first)).toBe(sha('bbbb'));
  });

  it('keeps the most recently used: a hit refreshes the entry', async () => {
    const first = put('first.txt', 'aaaa');
    const file = join(directory, 'first.txt');
    const mtime = new Date(1_700_000_000_000);
    utimesSync(file, mtime, mtime);
    expect(await mediaSha256(first)).toBe(sha('aaaa'));
    for (let i = 0; i < 499; i++) {
      await mediaSha256(put(`f${i}.txt`, `file ${i}`));
    }
    // A hit moves it to the end, then two more push out the oldest two.
    expect(await mediaSha256(first)).toBe(sha('aaaa'));
    for (let i = 0; i < 2; i++) {
      await mediaSha256(put(`g${i}.txt`, `file g${i}`));
    }
    writeFileSync(file, 'bbbb');
    utimesSync(file, mtime, mtime);
    expect(await mediaSha256(first)).toBe(sha('aaaa'));
  });

  it('shares a run going on: two calls at once read the file once', async () => {
    const path = put('shared.bin', Buffer.alloc(3 * (1 << 20), 7));
    const spy = fs.createReadStream as unknown as jest.Mock;
    const [one, two, three] = await Promise.all([
      mediaSha256(path),
      mediaSha256(path),
      mediaSha256(path),
    ]);
    expect(one).toBe(sha(Buffer.alloc(3 * (1 << 20), 7)));
    expect(two).toBe(one);
    expect(three).toBe(one);
    expect(spy).toHaveBeenCalledTimes(1);
    // Read in blocks of 1 MiB.
    expect(spy.mock.calls[0][1]).toMatchObject({ highWaterMark: 1 << 20 });
    // The run is over: the next call is answered from the cache.
    await mediaSha256(path);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a run that fails gives null and the next call tries again', async () => {
    const path = put('fail.txt', 'a');
    const spy = jest
      .spyOn(fs, 'createReadStream')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    expect(await mediaSha256(path)).toBeNull();
    expect(await mediaSha256(path)).toBe(sha('a'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('is null for a missing file', async () => {
    expect(await mediaSha256(url('missing.png'))).toBeNull();
  });

  it('is null for a folder instead of a file', async () => {
    mkdirSync(join(directory, 'folder'));
    expect(await mediaSha256(url('folder'))).toBeNull();
  });

  it('is null for a path that ends on the upload folder itself', async () => {
    expect(await mediaSha256(`${BASE}/uploads/`)).toBeNull();
    expect(await mediaSha256(`${BASE}/uploads/.`)).toBeNull();
  });

  it.each([
    ['dot dot', `${BASE}/uploads/../outside.txt`],
    ['dot dot inside', `${BASE}/uploads/a/../../outside.txt`],
    ['absolute after the prefix', `${BASE}/uploads//etc/passwd`],
    ['encoded slashes stay literal', `${BASE}/uploads/..%2Foutside.txt`],
  ])('is null for a path that leaves the folder: %s', async (_name, path) => {
    // A real file next to the upload folder, reachable by "..".
    writeFileSync(join(directory, '..', 'outside.txt'), 'outside');
    try {
      expect(await mediaSha256(path)).toBeNull();
    } finally {
      rmSync(join(directory, '..', 'outside.txt'), { force: true });
    }
  });

  it('is null for a sibling folder that only starts like the upload folder', async () => {
    const sibling = `${directory}-other`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 's.txt'), 's');
    try {
      const name = `../${sibling.split('/').pop()}/s.txt`;
      expect(await mediaSha256(url(name))).toBeNull();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('is null for an address with another prefix or another FRONTEND_URL', async () => {
    put('a.txt', 'a');
    expect(await mediaSha256(`${BASE}/files/a.txt`)).toBeNull();
    expect(await mediaSha256(`${BASE}/uploadsa.txt`)).toBeNull();
    expect(
      await mediaSha256(`https://other.example.test/uploads/a.txt`)
    ).toBeNull();
    expect(
      await mediaSha256(`http://hub.example.test/uploads/a.txt`)
    ).toBeNull();
    expect(await mediaSha256('a.txt')).toBeNull();
    expect(await mediaSha256('')).toBeNull();
    process.env.FRONTEND_URL = 'https://other.example.test';
    expect(await mediaSha256(url('a.txt'))).toBeNull();
  });

  it('is null without FRONTEND_URL', async () => {
    const path = put('a.txt', 'a');
    delete process.env.FRONTEND_URL;
    expect(await mediaSha256(path)).toBeNull();
    // "undefined/uploads/" must not count as a prefix.
    expect(await mediaSha256('undefined/uploads/a.txt')).toBeNull();
  });

  it('is null without UPLOAD_DIRECTORY', async () => {
    const path = put('a.txt', 'a');
    delete process.env.UPLOAD_DIRECTORY;
    expect(await mediaSha256(path)).toBeNull();
    process.env.UPLOAD_DIRECTORY = '';
    expect(await mediaSha256(path)).toBeNull();
  });

  it('is null for STORAGE_PROVIDER cloudflare', async () => {
    const path = put('a.txt', 'a');
    process.env.STORAGE_PROVIDER = 'cloudflare';
    expect(await mediaSha256(path)).toBeNull();
    process.env.CLOUDFLARE_BUCKET_URL = BASE;
    try {
      // Cloudflare is flat and not in the upload folder, also with a match.
      expect(await mediaSha256(url('a.txt'))).toBeNull();
    } finally {
      delete process.env.CLOUDFLARE_BUCKET_URL;
    }
  });

  // Like Postiz: everything except cloudflare is the local storage.
  it.each(['Local', 'r2', 'anything'])(
    'counts STORAGE_PROVIDER %s as local',
    async (provider) => {
      const path = put('a.txt', 'a');
      process.env.STORAGE_PROVIDER = provider;
      expect(await mediaSha256(path)).toBe(sha('a'));
    }
  );

  // storageLocation takes the slash at the end of the whole prefix; the
  // address Postiz writes is FRONTEND_URL + /uploads/, so a slash at the end
  // of FRONTEND_URL gives a double one in the path and still matches.
  it('matches the address Postiz writes for a FRONTEND_URL with a slash', async () => {
    put('a.txt', 'a');
    process.env.FRONTEND_URL = `${BASE}/`;
    expect(await mediaSha256(`${BASE}//uploads/a.txt`)).toBe(sha('a'));
    expect(await mediaSha256(url('a.txt'))).toBeNull();
  });

  it('is null for ".." in the rest, also when it stays inside the folder', async () => {
    mkdirSync(join(directory, 'sub'));
    put('b.txt', 'b');
    expect(await mediaSha256(url('sub/../b.txt'))).toBeNull();
    put('a..b.txt', 'x');
    expect(await mediaSha256(url('a..b.txt'))).toBeNull();
  });

  it('is null for a file above MEDIA_HASH_MAX_BYTES, and reads one at the limit', async () => {
    expect(MEDIA_HASH_MAX_BYTES).toBe(512 * 1024 * 1024);
    const path = put('big.bin', 'x');
    const real = jest.requireActual('fs/promises').stat;
    const spy = fsPromises.stat as unknown as jest.Mock;
    spy.mockImplementation(async (...args: unknown[]) => {
      const info = await real(...args);
      return Object.assign(info, { size: MEDIA_HASH_MAX_BYTES + 1 });
    });
    expect(await mediaSha256(path)).toBeNull();

    spy.mockImplementation(async (...args: unknown[]) => {
      const info = await real(...args);
      return Object.assign(info, { size: MEDIA_HASH_MAX_BYTES });
    });
    expect(await mediaSha256(path)).toBe(sha('x'));
  });

  it('is null for a file that cannot be read', async () => {
    const path = put('locked.txt', 'a');
    chmodNone(join(directory, 'locked.txt'));
    // Running as root can read anything, then there is nothing to check.
    if (process.getuid?.() === 0) {
      return;
    }
    expect(await mediaSha256(path)).toBeNull();
  });

  it('is null for a link that leads out of the upload folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ysocial-out-'));
    try {
      writeFileSync(join(outside, 'o.txt'), 'o');
      symlinkSync(join(outside, 'o.txt'), join(directory, 'link.txt'));
      symlinkSync(outside, join(directory, 'linkdir'));
      expect(await mediaSha256(url('link.txt'))).toBeNull();
      expect(await mediaSha256(url('linkdir/o.txt'))).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a link inside the upload folder that points to a file inside it', async () => {
    mkdirSync(join(directory, 'real'));
    writeFileSync(join(directory, 'real', 'r.txt'), 'r');
    symlinkSync(join(directory, 'real', 'r.txt'), join(directory, 'link.txt'));
    symlinkSync(join(directory, 'real'), join(directory, 'linkdir'));
    expect(await mediaSha256(url('link.txt'))).toBe(sha('r'));
    expect(await mediaSha256(url('linkdir/r.txt'))).toBe(sha('r'));
  });
});

function chmodNone(file: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('fs').chmodSync(file, 0o000);
}

describe('YsocialReadService media (K6)', () => {
  const postRow = {
    id: 'post-1',
    organizationId: 'org-1',
    group: 'g-1',
    parentPostId: null as string | null,
    image: JSON.stringify([
      { id: 'media-1', path: 'https://uploads.example.com/a.png' },
    ]),
    error: null as string | null,
    settings: null as string | null,
  };

  class Service extends YsocialReadService {
    hashes = jest.fn(async (path: string) => `hash:${path}`);
    constructor(read: Partial<YsocialReadRepository>) {
      super(read as YsocialReadRepository);
      this.hashMedium = this.hashes;
    }
  }

  it('getPosts: size, no sha256, hashMedium never called', async () => {
    const read = {
      getPosts: jest.fn().mockResolvedValue([postRow]),
      getMedia: jest.fn().mockResolvedValue([
        {
          id: 'media-1',
          organizationId: 'org-1',
          path: 'https://uploads.example.com/a.png',
          fileSize: 42,
        },
      ]),
    };
    const service = new Service(read);
    const [post] = await service.getPosts(
      '2026-10-27T00:00:00Z',
      '2026-10-28T00:00:00Z'
    );
    expect(post.image).toEqual([
      { path: 'https://uploads.example.com/a.png', type: 'image', size: 42 },
    ]);
    expect(service.hashes).not.toHaveBeenCalled();
  });

  it('getPost: sha256 for the post and its comments, size by the one query', async () => {
    const comment = {
      ...postRow,
      id: 'post-2',
      parentPostId: 'post-1',
      image: JSON.stringify([
        { id: 'media-1', path: 'https://uploads.example.com/a.png' },
        { id: 'media-2', path: 'https://uploads.example.com/b.mp4' },
      ]),
    };
    const read = {
      getPost: jest.fn().mockResolvedValue(postRow),
      getPostGroup: jest.fn().mockResolvedValue([postRow, comment]),
      getMedia: jest.fn().mockResolvedValue([
        {
          id: 'media-1',
          organizationId: 'org-1',
          path: 'https://uploads.example.com/a.png',
          fileSize: 42,
        },
      ]),
    };
    const service = new Service(read);
    const body = await service.getPost('post-1', true);
    expect(body.image).toEqual([
      {
        path: 'https://uploads.example.com/a.png',
        type: 'image',
        size: 42,
        sha256: 'hash:https://uploads.example.com/a.png',
      },
    ]);
    expect(body.comments[0].image).toEqual([
      {
        path: 'https://uploads.example.com/a.png',
        type: 'image',
        size: 42,
        sha256: 'hash:https://uploads.example.com/a.png',
      },
      {
        path: 'https://uploads.example.com/b.mp4',
        type: 'video',
        size: null,
        sha256: 'hash:https://uploads.example.com/b.mp4',
      },
    ]);
    expect(read.getMedia).toHaveBeenCalledTimes(1);
    expect(read.getMedia).toHaveBeenCalledWith(['media-1', 'media-2']);
  });

  it('getPost: a hash that is null stays null next to a size', async () => {
    const read = {
      getPost: jest.fn().mockResolvedValue(postRow),
      getPostGroup: jest.fn().mockResolvedValue([postRow]),
      getMedia: jest.fn().mockResolvedValue([]),
    };
    const service = new Service(read);
    service.hashes.mockResolvedValue(null as any);
    const body = await service.getPost('post-1', true);
    expect(body.image[0]).toMatchObject({ size: null, sha256: null });
  });

  it('getPost without hashes: no sha256 field at all, hashMedium never called', async () => {
    const comment = { ...postRow, id: 'post-2', parentPostId: 'post-1' };
    const read = {
      getPost: jest.fn().mockResolvedValue(postRow),
      getPostGroup: jest.fn().mockResolvedValue([postRow, comment]),
      getMedia: jest.fn().mockResolvedValue([]),
    };
    const service = new Service(read);
    for (const body of [
      await service.getPost('post-1'),
      await service.getPost('post-1', false),
    ]) {
      for (const row of [body, ...body.comments]) {
        for (const item of row.image) {
          expect(item).not.toHaveProperty('sha256');
          expect(Object.keys(item).sort()).toEqual(['path', 'size', 'type']);
        }
      }
    }
    expect(service.hashes).not.toHaveBeenCalled();
  });

  it('getPost with hashes: the media of a post are hashed in parallel', async () => {
    const image = JSON.stringify(
      [1, 2, 3].map((n) => ({ path: `https://uploads.example.com/${n}.png` }))
    );
    const read = {
      getPost: jest.fn().mockResolvedValue({ ...postRow, image }),
      getPostGroup: jest.fn().mockResolvedValue([{ ...postRow, image }]),
      getMedia: jest.fn(),
    };
    const service = new Service(read);
    const release: Array<() => void> = [];
    service.hashes.mockImplementation(
      (path: string) =>
        new Promise<string>((done) => release.push(() => done(`h:${path}`)))
    );
    const pending = service.getPost('post-1', true);
    await new Promise((done) => setTimeout(done, 20));
    // All three runs started before the first one is finished.
    expect(service.hashes).toHaveBeenCalledTimes(3);
    release.forEach((fn) => fn());
    const body = await pending;
    expect(body.image.map((item: any) => item.sha256)).toEqual([
      'h:https://uploads.example.com/1.png',
      'h:https://uploads.example.com/2.png',
      'h:https://uploads.example.com/3.png',
    ]);
  });

  it('does not call getMedia when no medium has an id', async () => {
    const noId = {
      ...postRow,
      image: JSON.stringify([
        { path: 'https://uploads.example.com/a.png' },
        { id: 7, path: 'https://uploads.example.com/b.png' },
        { id: '', path: 'https://uploads.example.com/c.png' },
      ]),
    };
    const read = {
      getPosts: jest.fn().mockResolvedValue([noId, { ...noId, image: null }]),
      getPost: jest.fn().mockResolvedValue(noId),
      getPostGroup: jest.fn().mockResolvedValue([noId]),
      getMedia: jest.fn(),
    };
    const service = new Service(read);
    const list = await service.getPosts(
      '2026-10-27T00:00:00Z',
      '2026-10-28T00:00:00Z'
    );
    expect(list[0].image.map((item) => item.size)).toEqual([null, null, null]);
    await service.getPost('post-1');
    expect(read.getMedia).not.toHaveBeenCalled();
  });
});

describe('size of a local file (K6)', () => {
  const saved: Record<string, string | undefined> = {};
  let directory: string;
  const post = (image: object[]) => ({
    id: 'post-1',
    organizationId: 'org-1',
    group: 'g-1',
    parentPostId: null as string | null,
    image: JSON.stringify(image),
    error: null as string | null,
    settings: null as string | null,
  });
  const sizesOf = async (rows: object[], media: object[]) => {
    const service = new YsocialReadService({
      getPosts: jest.fn().mockResolvedValue(rows),
      getMedia: jest.fn().mockResolvedValue(media),
    } as unknown as YsocialReadRepository);
    const [first] = await service.getPosts(
      '2026-10-27T00:00:00Z',
      '2026-10-28T00:00:00Z'
    );
    return first.image.map((item) => item.size);
  };
  const row = (path: string, fileSize: number, organizationId = 'org-1') => ({
    id: 'media-1',
    organizationId,
    path,
    fileSize,
  });

  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
    }
    directory = mkdtempSync(join(tmpdir(), 'ysocial-size-'));
    process.env.FRONTEND_URL = BASE;
    process.env.UPLOAD_DIRECTORY = directory;
    delete process.env.STORAGE_PROVIDER;
    writeFileSync(join(directory, 'a.png'), Buffer.alloc(321));
  });

  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('fileSize 0 and a local file: the size of the file', async () => {
    const path = url('a.png');
    expect(
      await sizesOf([post([{ id: 'media-1', path }])], [row(path, 0)])
    ).toEqual([321]);
  });

  it('fileSize above 0 wins over the file', async () => {
    const path = url('a.png');
    expect(
      await sizesOf([post([{ id: 'media-1', path }])], [row(path, 99)])
    ).toEqual([99]);
  });

  it('fileSize 0 and the file is missing, a folder or elsewhere: null', async () => {
    mkdirSync(join(directory, 'folder'));
    for (const path of [
      url('missing.png'),
      url('folder'),
      'https://uploads.example.com/a.png',
      url('../a.png'),
    ]) {
      expect(
        await sizesOf([post([{ id: 'media-1', path }])], [row(path, 0)])
      ).toEqual([null]);
    }
  });

  it('fileSize 0 on Cloudflare: null', async () => {
    process.env.STORAGE_PROVIDER = 'cloudflare';
    const path = url('a.png');
    expect(
      await sizesOf([post([{ id: 'media-1', path }])], [row(path, 0)])
    ).toEqual([null]);
  });

  it('the file only counts when the row fits: other organization or path, no row', async () => {
    const path = url('a.png');
    const rows = [post([{ id: 'media-1', path }])];
    expect(await sizesOf(rows, [row(path, 0, 'org-2')])).toEqual([null]);
    expect(await sizesOf(rows, [row(url('b.png'), 0)])).toEqual([null]);
    expect(await sizesOf(rows, [])).toEqual([null]);
    expect(await sizesOf([post([{ path }])], [row(path, 0)])).toEqual([null]);
  });
});
