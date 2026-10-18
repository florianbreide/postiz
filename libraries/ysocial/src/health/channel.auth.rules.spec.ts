import { ApplicationFailure } from '@temporalio/common';
import {
  classifyAnalyticsError,
  classifyAnalyticsResult,
} from './channel.auth.rules';

describe('what analytics says about the token', () => {
  it('RefreshToken and Disconnect of any provider mean "Zugang ungültig"', () => {
    for (const type of ['refresh_token', 'disconnect']) {
      const err = ApplicationFailure.create({ message: 'x', type });
      expect(classifyAnalyticsError('linkedin-page', err).result).toBe(
        'auth_invalid'
      );
    }
  });

  it.each([
    'Error validating access token: The user has not authorized application 1234.',
    'Error validating access token: Session has expired on Monday, 26-Oct-26.',
    'The session has been invalidated because the user changed their password.',
    '(#190) This Page access token belongs to a Page that has been deleted.',
  ])('facebook: "%s" means "Zugang ungültig"', (message) => {
    const result = classifyAnalyticsError('facebook', new Error(message));
    expect(result.result).toBe('auth_invalid');
  });

  it('other errors are "unklar", no alarm', () => {
    expect(
      classifyAnalyticsError(
        'facebook',
        new Error('(#4) Application request limit reached')
      ).result
    ).toBe('unclear');
    expect(
      classifyAnalyticsError(
        'linkedin-page',
        new Error('Error validating access token')
      ).result
    ).toBe('unclear');
  });

  it('an empty answer of instagram is "unklar", of facebook "ok"', () => {
    expect(classifyAnalyticsResult('instagram', []).result).toBe('unclear');
    expect(
      classifyAnalyticsResult('instagram', [{ label: 'Reach' }]).result
    ).toBe('ok');
    expect(classifyAnalyticsResult('facebook', []).result).toBe('ok');
    expect(classifyAnalyticsResult('linkedin-page', []).result).toBe('ok');
  });
});
