import { automatedPost, hasInternalPlug } from './automation.rules';

describe('hasInternalPlug', () => {
  it('is false without a plug', () => {
    expect(hasInternalPlug({})).toBe(false);
    expect(hasInternalPlug({ title: 'x', 'plug--like--active': true })).toBe(
      false
    );
  });

  it('is true for a plug with channels', () => {
    expect(hasInternalPlug({ 'plug--like--integrations': ['c1'] })).toBe(true);
  });

  it('is false for an empty channel list', () => {
    expect(hasInternalPlug({ 'plug--like--integrations': [] })).toBe(false);
  });

  it('is false for --active alone, as Postiz runs the plug by integrations', () => {
    expect(hasInternalPlug({ 'plug--like--active': true })).toBe(false);
  });

  it('is false for integrations that are not a list', () => {
    expect(hasInternalPlug({ 'plug--like--integrations': 'c1' })).toBe(false);
  });

  it('counts a part named __proto__ as yes', () => {
    expect(hasInternalPlug({ 'plug--__proto__--active': true })).toBe(true);
    expect(hasInternalPlug({ 'plug--like--__proto__': 1 })).toBe(true);
    expect(
      hasInternalPlug(JSON.parse('{"plug--__proto__--integrations":[]}'))
    ).toBe(true);
  });

  it.each([null, undefined, 'plug-', 5, true])(
    'is false for a non-object (%p)',
    (value) => {
      expect(hasInternalPlug(value)).toBe(false);
    }
  );

  it('is false for an array, even one holding plug keys', () => {
    expect(hasInternalPlug([])).toBe(false);
    expect(hasInternalPlug([{ 'plug--like--integrations': ['c1'] }])).toBe(
      false
    );
  });
});

describe('automatedPost', () => {
  const plugPost = { settings: { 'plug--like--integrations': ['c1'] } };

  it.each([
    [0, null],
    [-1, null],
    ['0', null],
    [null, null],
    [undefined, null],
    ['', null],
    ['abc', null],
    [7, 'repeat'],
    ['7', 'repeat'],
    [1.5, 'repeat'],
  ])('inter %p gives %p', (inter, expected) => {
    expect(automatedPost({ inter, posts: [] })).toBe(expected);
  });

  it('allows a body without inter', () => {
    expect(automatedPost({ posts: [{ settings: {} }] })).toBeNull();
  });

  it('finds the plug in one of several posts', () => {
    expect(
      automatedPost({
        posts: [{ settings: {} }, { settings: { __type: 'x' } }, plugPost],
      })
    ).toBe('plug');
  });

  it('gives repeat before plug', () => {
    expect(automatedPost({ inter: 3, posts: [plugPost] })).toBe('repeat');
  });

  it('allows posts without a plug', () => {
    expect(
      automatedPost({ posts: [{ settings: {} }, {}, { settings: null }] })
    ).toBeNull();
  });

  it.each([null, undefined, 'x', 5, [], { posts: 'x' }, { posts: [null] }])(
    'does not throw and allows a malformed body (%p)',
    (body) => {
      expect(() => automatedPost(body)).not.toThrow();
    }
  );
});
