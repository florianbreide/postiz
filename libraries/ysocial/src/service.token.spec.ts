import { randomBytes } from 'crypto';
import {
  checkServiceToken,
  isServiceTokenConfigured,
  readBearerToken,
  tokensMatch,
  YSOCIAL_SERVICE_TOKEN_MIN_LENGTH,
} from './service.token';

const token = randomBytes(32).toString('hex');

describe('isServiceTokenConfigured', () => {
  it('rejects missing, empty and short values', () => {
    expect(isServiceTokenConfigured(undefined)).toBe(false);
    expect(isServiceTokenConfigured('')).toBe(false);
    expect(isServiceTokenConfigured('   ')).toBe(false);
    expect(
      isServiceTokenConfigured('a'.repeat(YSOCIAL_SERVICE_TOKEN_MIN_LENGTH - 1))
    ).toBe(false);
  });

  it('accepts a long enough value', () => {
    expect(isServiceTokenConfigured(token)).toBe(true);
  });
});

describe('readBearerToken', () => {
  it('reads the token from a Bearer header', () => {
    expect(readBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readBearerToken(`bearer ${token}`)).toBe(token);
  });

  it('ignores other schemes and malformed headers', () => {
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken('')).toBeUndefined();
    expect(readBearerToken(token)).toBeUndefined();
    expect(readBearerToken(`Basic ${token}`)).toBeUndefined();
    expect(readBearerToken('Bearer')).toBeUndefined();
    expect(readBearerToken(`Bearer ${token} extra`)).toBeUndefined();
  });
});

describe('tokensMatch', () => {
  it('compares tokens of any length without throwing', () => {
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, token.slice(0, 10))).toBe(false);
    expect(tokensMatch(token, `${token}x`)).toBe(false);
  });
});

describe('checkServiceToken', () => {
  it('fails closed when no token is configured', () => {
    expect(checkServiceToken(undefined, `Bearer ${token}`)).toBe(
      'not_configured'
    );
    expect(checkServiceToken('', undefined)).toBe('not_configured');
    expect(checkServiceToken('short', 'Bearer short')).toBe('not_configured');
  });

  it('reports a missing token', () => {
    expect(checkServiceToken(token, undefined)).toBe('missing');
    expect(checkServiceToken(token, `Basic ${token}`)).toBe('missing');
  });

  it('reports a wrong token', () => {
    const other = randomBytes(32).toString('hex');
    expect(checkServiceToken(token, `Bearer ${other}`)).toBe('invalid');
  });

  it('accepts the right token', () => {
    expect(checkServiceToken(token, `Bearer ${token}`)).toBe('ok');
    expect(checkServiceToken(` ${token} `, `Bearer ${token}`)).toBe('ok');
  });
});
