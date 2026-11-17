import { createHmac, randomBytes } from 'crypto';
import {
  checkSignature,
  checkVerifyRequest,
  isChallenge,
  META_APP_SECRET_ENV,
  webhookEvents,
  YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV,
} from './webhook.rules';

const verifyToken = randomBytes(32).toString('hex');
const appSecret = randomBytes(24).toString('hex');

const sign = (body: Buffer | string, secret = appSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('checkVerifyRequest', () => {
  const env = { [YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV]: verifyToken };

  it('accepts subscribe with the configured token', () => {
    expect(checkVerifyRequest(env, 'subscribe', verifyToken)).toBe('ok');
  });

  it('accepts a token that has blanks at the edge in the environment', () => {
    expect(
      checkVerifyRequest(
        { [YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV]: ` ${verifyToken}\n` },
        'subscribe',
        verifyToken
      )
    ).toBe('ok');
  });

  it('does not accept a token with blanks at the edge from the request', () => {
    expect(checkVerifyRequest(env, 'subscribe', ` ${verifyToken}`)).toBe(
      'invalid'
    );
  });

  it('is not configured without the variable, empty, blank or too short', () => {
    for (const configured of [
      undefined,
      '',
      ' '.repeat(40),
      randomBytes(15).toString('hex').slice(0, 31),
    ]) {
      expect(
        checkVerifyRequest(
          { [YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV]: configured },
          'subscribe',
          configured ?? verifyToken
        )
      ).toBe('not_configured');
    }
    expect(checkVerifyRequest({}, 'subscribe', verifyToken)).toBe(
      'not_configured'
    );
  });

  it('counts a token of exactly 32 characters as configured', () => {
    const token = randomBytes(16).toString('hex');
    expect(token).toHaveLength(32);
    expect(
      checkVerifyRequest(
        { [YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV]: token },
        'subscribe',
        token
      )
    ).toBe('ok');
  });

  it('checks the configuration before the request', () => {
    expect(checkVerifyRequest({}, 'wrong', undefined)).toBe('not_configured');
  });

  it('is invalid for any other mode', () => {
    for (const mode of [
      undefined,
      '',
      'unsubscribe',
      'SUBSCRIBE',
      ['subscribe'],
    ]) {
      expect(checkVerifyRequest(env, mode, verifyToken)).toBe('invalid');
    }
  });

  it('is invalid for a wrong, missing or not-string token', () => {
    for (const token of [
      undefined,
      '',
      randomBytes(32).toString('hex'),
      verifyToken.slice(0, -1),
      `${verifyToken}x`,
      [verifyToken],
      { toString: () => verifyToken },
    ]) {
      expect(checkVerifyRequest(env, 'subscribe', token)).toBe('invalid');
    }
  });
});

describe('isChallenge', () => {
  it('accepts digits only, 1 to 64 of them', () => {
    expect(isChallenge('1')).toBe(true);
    expect(isChallenge('1158201444')).toBe(true);
    expect(isChallenge('9'.repeat(64))).toBe(true);
  });

  it('rejects everything else', () => {
    for (const value of [
      undefined,
      null,
      123,
      '',
      '9'.repeat(65),
      '12 3',
      '123\n',
      '-1',
      '1.5',
      '1e3',
      'abc',
      '<script>1</script>',
      ['123'],
    ]) {
      expect(isChallenge(value)).toBe(false);
    }
  });
});

describe('checkSignature', () => {
  const env = { [META_APP_SECRET_ENV]: appSecret };
  const body = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));

  it('accepts the HMAC-SHA256 of the raw body', () => {
    expect(checkSignature(env, body, sign(body))).toBe('ok');
  });

  it('accepts upper case and lower case hex and either spelling of sha256=', () => {
    const hex = sign(body).slice('sha256='.length);
    expect(checkSignature(env, body, `sha256=${hex.toUpperCase()}`)).toBe('ok');
    expect(checkSignature(env, body, `SHA256=${hex}`)).toBe('ok');
  });

  it('takes the first value of a header that arrives as an array', () => {
    expect(checkSignature(env, body, [sign(body)])).toBe('ok');
    expect(checkSignature(env, body, [sign(body), 'sha256=junk'])).toBe('ok');
    expect(checkSignature(env, body, ['sha256=junk', sign(body)])).toBe(
      'missing'
    );
    expect(checkSignature(env, body, [])).toBe('missing');
  });

  it('is invalid when one byte of the body changed', () => {
    const signature = sign(body);
    const changed = Buffer.from(body);
    changed[changed.length - 1] ^= 1;
    expect(checkSignature(env, changed, signature)).toBe('invalid');
    // Same text, one byte longer.
    expect(
      checkSignature(env, Buffer.concat([body, Buffer.from(' ')]), signature)
    ).toBe('invalid');
  });

  it('is invalid when the body was parsed and written again', () => {
    const pretty = Buffer.from(
      JSON.stringify(JSON.parse(body.toString()), null, 2)
    );
    expect(checkSignature(env, pretty, sign(body))).toBe('invalid');
  });

  it('is invalid for a signature of another secret', () => {
    expect(
      checkSignature(env, body, sign(body, randomBytes(24).toString('hex')))
    ).toBe('invalid');
  });

  it('is invalid for a signature of another body', () => {
    expect(checkSignature(env, body, sign('{}'))).toBe('invalid');
  });

  it('is invalid for the right length of 64 digits that is not the HMAC', () => {
    expect(checkSignature(env, body, `sha256=${'0'.repeat(64)}`)).toBe(
      'invalid'
    );
  });

  it('is missing for the wrong length, characters, prefix or algorithm', () => {
    const hex = sign(body).slice('sha256='.length);
    for (const header of [
      undefined,
      '',
      'sha256=',
      `sha256=${hex.slice(0, 63)}`,
      `sha256=${hex}0`,
      `sha256=${'g'.repeat(64)}`,
      hex,
      `sha1=${hex}`,
      `sha256 ${hex}`,
      ` sha256=${hex}`,
      `sha256=${hex} `,
    ]) {
      expect(checkSignature(env, body, header)).toBe('missing');
    }
  });

  it('is invalid without a raw body, also for a well-formed header', () => {
    expect(checkSignature(env, undefined, sign(body))).toBe('invalid');
    expect(
      checkSignature(env, '{"a":1}' as unknown as Buffer, sign('{"a":1}'))
    ).toBe('invalid');
  });

  it('accepts an empty raw body when it is signed', () => {
    expect(checkSignature(env, Buffer.alloc(0), sign(''))).toBe('ok');
  });

  it('is not configured without a secret, empty or only blanks', () => {
    for (const secret of [undefined, '', ' ', ' \t\n']) {
      expect(
        checkSignature({ [META_APP_SECRET_ENV]: secret }, body, sign(body, ' '))
      ).toBe('not_configured');
    }
    expect(checkSignature({}, body, sign(body))).toBe('not_configured');
  });

  it('checks the secret before the header', () => {
    expect(checkSignature({}, undefined, undefined)).toBe('not_configured');
  });

  it('uses the secret as it is, without trimming', () => {
    const padded = ` ${appSecret} `;
    expect(
      checkSignature(
        { [META_APP_SECRET_ENV]: padded },
        body,
        sign(body, padded)
      )
    ).toBe('ok');
    expect(
      checkSignature({ [META_APP_SECRET_ENV]: padded }, body, sign(body))
    ).toBe('invalid');
  });
});

describe('webhookEvents', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');
  const PAGE = '100000000000001';
  const POST = `${PAGE}_200000000000001`;
  const COMMENT = `${POST}_300000000000001`;

  // Everything that must never reach the log.
  const PRIVATE = [
    'Erfundener Kommentartext',
    'Erfundene Person',
    'erfundene_person',
    '500000000000777',
    'Erfundene Seite',
  ];

  const feedChange = (value: Record<string, unknown> = {}, field = 'feed') => ({
    field,
    value: {
      item: 'comment',
      verb: 'add',
      post_id: POST,
      comment_id: COMMENT,
      parent_id: POST,
      created_time: 1_795_000_000,
      message: PRIVATE[0],
      from: { name: PRIVATE[1], id: PRIVATE[3] },
      ...value,
    },
  });
  const page = (changes: unknown[], entry: Record<string, unknown> = {}) => ({
    object: 'page',
    entry: [{ id: PAGE, time: 1_795_000_100, changes, ...entry }],
  });

  const expectNoPrivateData = (result: unknown) => {
    const text = JSON.stringify(result);
    for (const secret of PRIVATE) {
      expect(text).not.toContain(secret);
    }
  };

  it('reduces a Page feed comment to ids, kind and time', () => {
    const result = webhookEvents(page([feedChange()]), now);
    expect(result).toEqual([
      {
        receivedAt: '2026-11-17T12:00:00.000Z',
        object: 'page',
        entryId: PAGE,
        sentAt: new Date(1_795_000_100_000).toISOString(),
        field: 'feed',
        item: 'comment',
        verb: 'add',
        postId: POST,
        commentId: COMMENT,
        parentId: POST,
        mediaId: null,
        createdAt: new Date(1_795_000_000_000).toISOString(),
      },
    ]);
    expectNoPrivateData(result);
  });

  it('reads other feed items such as a status or a reaction', () => {
    const [event] = webhookEvents(
      page([
        {
          field: 'feed',
          value: { item: 'reaction', verb: 'remove', post_id: POST },
        },
      ]),
      now
    );
    expect(event).toMatchObject({
      item: 'reaction',
      verb: 'remove',
      postId: POST,
      commentId: null,
      parentId: null,
      createdAt: null,
    });
  });

  it('reads an Instagram comment with comment_id', () => {
    const result = webhookEvents(
      {
        object: 'instagram',
        entry: [
          {
            id: '17840000000000001',
            time: 1_795_000_100,
            changes: [
              {
                field: 'comments',
                value: {
                  comment_id: '17950000000000001',
                  parent_id: '17950000000000000',
                  media: {
                    id: '17900000000000001',
                    media_product_type: 'FEED',
                  },
                  from: { id: PRIVATE[3], username: PRIVATE[2] },
                  text: PRIVATE[0],
                },
              },
            ],
          },
        ],
      },
      now
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      object: 'instagram',
      entryId: '17840000000000001',
      field: 'comments',
      item: null,
      verb: null,
      commentId: '17950000000000001',
      parentId: '17950000000000000',
      mediaId: '17900000000000001',
    });
    expectNoPrivateData(result);
  });

  it('reads an Instagram comment that carries only id', () => {
    const [event] = webhookEvents(
      {
        object: 'instagram',
        entry: [
          {
            id: '17840000000000001',
            changes: [
              {
                field: 'comments',
                value: {
                  id: '17950000000000002',
                  media: { id: '17900000000000001' },
                  text: PRIVATE[0],
                  from: { username: PRIVATE[2] },
                },
              },
            ],
          },
        ],
      },
      now
    );
    expect(event.commentId).toBe('17950000000000002');
    expectNoPrivateData(event);
  });

  it('prefers comment_id over id on Instagram', () => {
    const [event] = webhookEvents(
      {
        object: 'instagram',
        entry: [
          {
            id: '1',
            changes: [
              { field: 'comments', value: { comment_id: '11', id: '22' } },
            ],
          },
        ],
      },
      now
    );
    expect(event.commentId).toBe('11');
  });

  it('does not take id as comment on a Page', () => {
    const [event] = webhookEvents(
      page([{ field: 'feed', value: { id: '123', item: 'status' } }]),
      now
    );
    expect(event.commentId).toBeNull();
  });

  it('takes numeric ids as numbers and writes them as text', () => {
    const [event] = webhookEvents(
      {
        object: 'instagram',
        entry: [
          {
            id: 17840000,
            changes: [
              {
                field: 'comments',
                value: { comment_id: 1795, parent_id: 0, media: { id: 17900 } },
              },
            ],
          },
        ],
      },
      now
    );
    expect(event).toMatchObject({
      entryId: '17840000',
      commentId: '1795',
      parentId: '0',
      mediaId: '17900',
    });
  });

  it('drops invalid ids to null', () => {
    const [event] = webhookEvents(
      page(
        [
          feedChange({
            post_id: 'abc',
            comment_id: '12 34',
            parent_id: '1'.repeat(65),
            media: { id: '../etc/passwd' },
          }),
        ],
        { id: 'not-an-id' }
      ),
      now
    );
    expect(event).toMatchObject({
      entryId: null,
      postId: null,
      commentId: null,
      parentId: null,
      mediaId: null,
    });
  });

  it('drops numbers that are no ids', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 60, true, {}, []]) {
      const [event] = webhookEvents(
        page([feedChange({ post_id: bad, comment_id: bad })]),
        now
      );
      expect(event.postId).toBeNull();
      expect(event.commentId).toBeNull();
    }
  });

  it('accepts an id of 64 characters, not of 65', () => {
    const ok = '1'.repeat(64);
    const [event] = webhookEvents(
      page([feedChange({ post_id: ok, comment_id: `${ok}x`.slice(0, 65) })]),
      now
    );
    expect(event.postId).toBe(ok);
    expect(event.commentId).toBeNull();
  });

  it('drops invalid item and verb to null, the event stays', () => {
    const [event] = webhookEvents(
      page([feedChange({ item: 'Comment', verb: 'add; DROP', post_id: POST })]),
      now
    );
    expect(event).toMatchObject({ item: null, verb: null, postId: POST });
  });

  it('drops a change without a valid field', () => {
    for (const field of [
      undefined,
      null,
      '',
      'Feed',
      'feed1',
      'a-b',
      'x'.repeat(41),
      5,
      ['feed'],
    ]) {
      expect(webhookEvents(page([{ field, value: {} }]), now)).toEqual([]);
    }
  });

  it('accepts a field of 40 characters', () => {
    const field = 'a'.repeat(39) + '_';
    expect(webhookEvents(page([{ field, value: {} }]), now)[0].field).toBe(
      field
    );
  });

  it('drops the whole payload for an invalid or missing object', () => {
    for (const object of [
      undefined,
      null,
      '',
      'Page',
      'page1',
      'x'.repeat(41),
      7,
    ]) {
      expect(webhookEvents({ ...page([feedChange()]), object }, now)).toEqual(
        []
      );
    }
  });

  it('keeps events of other known objects', () => {
    const [event] = webhookEvents(
      { ...page([feedChange()]), object: 'whatsapp_business_account' },
      now
    );
    expect(event.object).toBe('whatsapp_business_account');
  });

  it('returns nothing for entries without changes', () => {
    expect(webhookEvents(page([]), now)).toEqual([]);
    expect(
      webhookEvents({ object: 'page', entry: [{ id: PAGE, time: 1 }] }, now)
    ).toEqual([]);
    expect(
      webhookEvents(
        { object: 'page', entry: [{ id: PAGE, changes: 'x' }] },
        now
      )
    ).toEqual([]);
    expect(
      webhookEvents({ object: 'page', entry: [null, 1, 'x'] }, now)
    ).toEqual([]);
  });

  it('returns nothing for messaging entries and keeps no text of them', () => {
    const result = webhookEvents(
      {
        object: 'page',
        entry: [
          {
            id: PAGE,
            time: 1_795_000_100,
            messaging: [
              {
                sender: { id: PRIVATE[3] },
                recipient: { id: PAGE },
                message: { text: PRIVATE[0] },
              },
            ],
          },
        ],
      },
      now
    );
    expect(result).toEqual([]);
  });

  it('ignores messaging next to changes in the same entry', () => {
    const result = webhookEvents(
      page([feedChange()], {
        messaging: [
          { sender: { id: PRIVATE[3] }, message: { text: PRIVATE[0] } },
        ],
      }),
      now
    );
    expect(result).toHaveLength(1);
    expectNoPrivateData(result);
  });

  it('returns nothing for payloads that are no notification', () => {
    for (const payload of [
      undefined,
      null,
      '',
      'x',
      42,
      [],
      {},
      { object: 'page' },
      { object: 'page', entry: {} },
      { object: 'page', entry: 'x' },
    ]) {
      expect(webhookEvents(payload, now)).toEqual([]);
    }
  });

  it('turns every change of every entry into one event, in order', () => {
    const result = webhookEvents(
      {
        object: 'page',
        entry: [
          {
            id: '1',
            changes: [
              feedChange({ comment_id: '11' }),
              { field: 'bad field' },
              feedChange({ comment_id: '12' }),
            ],
          },
          { id: '2', changes: [feedChange({ comment_id: '21' })] },
        ],
      },
      now
    );
    expect(result.map((event) => [event.entryId, event.commentId])).toEqual([
      ['1', '11'],
      ['1', '12'],
      ['2', '21'],
    ]);
  });

  it('keeps the event when value is missing or not an object', () => {
    for (const value of [undefined, null, 'x', 5]) {
      const result = webhookEvents(page([{ field: 'feed', value }]), now);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        field: 'feed',
        item: null,
        postId: null,
        commentId: null,
      });
    }
  });

  it('turns Unix seconds into ISO and drops invalid times', () => {
    const [event] = webhookEvents(
      page([feedChange({ created_time: 1_795_000_000 })], { time: 0 }),
      now
    );
    expect(event.createdAt).toBe('2026-11-18T11:06:40.000Z');
    expect(event.sentAt).toBeNull();
    // 1e13 seconds is beyond the range of Date: null instead of a RangeError.
    for (const bad of [-5, NaN, Infinity, 1e13, '1795000000', null, {}]) {
      const [e] = webhookEvents(
        page([feedChange({ created_time: bad })], { time: bad }),
        now
      );
      expect(e.createdAt).toBeNull();
      expect(e.sentAt).toBeNull();
    }
  });

  it('takes the receive time from the clock that was passed', () => {
    const [event] = webhookEvents(page([feedChange()]), now);
    expect(event.receivedAt).toBe(now.toISOString());
  });

  it('never carries message, text or the person, whatever the shape', () => {
    const hostile = {
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: 1_795_000_100,
          changes: [
            feedChange({
              item: 'comment',
              message: PRIVATE[0],
              text: PRIVATE[0],
              from: { name: PRIVATE[1], username: PRIVATE[2], id: PRIVATE[3] },
              story: PRIVATE[4],
              sender_name: PRIVATE[1],
            }),
          ],
          extra: PRIVATE[0],
        },
      ],
      message: PRIVATE[0],
    };
    const result = webhookEvents(hostile, now);
    expect(result).toHaveLength(1);
    expectNoPrivateData(result);
    expect(Object.keys(result[0]).sort()).toEqual(
      [
        'receivedAt',
        'object',
        'entryId',
        'sentAt',
        'field',
        'item',
        'verb',
        'postId',
        'commentId',
        'parentId',
        'mediaId',
        'createdAt',
      ].sort()
    );
  });
});
