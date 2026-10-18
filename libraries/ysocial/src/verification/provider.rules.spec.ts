import { POST_VERIFICATION_RULES, ruleFor } from './provider.rules';

describe('post verification rules per provider', () => {
  it('arms only facebook and instagram in phase 1 (R22)', () => {
    expect(Object.keys(POST_VERIFICATION_RULES).sort()).toEqual([
      'facebook',
      'instagram',
      'instagram-standalone',
    ]);
    for (const other of ['linkedin-page', 'youtube', 'tiktok', 'gmb', 'x']) {
      expect(ruleFor(other)).toBeUndefined();
    }
  });

  it.each(['facebook', 'instagram', 'instagram-standalone'])(
    '%s: a metric means "exists", an empty list "not found"',
    (provider) => {
      const rule = ruleFor(provider)!;
      expect(
        rule.classify([
          {
            label: 'Impressions',
            percentageChange: 0,
            data: [{ total: '0', date: '2026-10-26' }],
          },
        ])
      ).toBe('found');
      expect(rule.classify([])).toBe('not_found');
      expect(rule.classify(undefined)).toBe('not_found');
      expect(rule.classify({ missing: true })).toBe('not_found');
    }
  );

  it('facebook checks feed posts only', () => {
    const rule = ruleFor('facebook')!;
    expect(rule.cannotCheck({ releaseId: '1234_5678' })).toBeUndefined();
    expect(rule.cannotCheck({ releaseId: '987654321' })).toContain('Reel');
  });

  it('instagram leaves stories out', () => {
    const rule = ruleFor('instagram')!;
    expect(
      rule.cannotCheck({ releaseId: '1', settings: '{"post_type":"post"}' })
    ).toBeUndefined();
    expect(
      rule.cannotCheck({ releaseId: '1', settings: null })
    ).toBeUndefined();
    expect(
      rule.cannotCheck({ releaseId: '1', settings: 'not json' })
    ).toBeUndefined();
    expect(
      rule.cannotCheck({ releaseId: '1', settings: '{"post_type":"story"}' })
    ).toContain('Story');
  });
});
