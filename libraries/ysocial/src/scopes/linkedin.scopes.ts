/**
 * LinkedIn page channels without OpenID Connect, „Weg A“ (PR 39, E58; Hub
 * docs/plattformen/linkedin.md 1.5). Used by ysocial patch 7 in the Postiz
 * provider "linkedin-page" (YSOCIAL-PATCHES.md).
 *
 * Y Social connects pages with an app that has only the product Community
 * Management API. LinkedIn does not grant openid and profile there, and
 * Postiz asks for both, checks every requested scope after the login
 * (SocialAbstract.checkScopes, NotEnoughScopes on HTTP 409) and reads the
 * member from /v2/userinfo, which needs them. So:
 *
 * - The scopes of the provider stay the list of Postiz, minus the ones in
 *   YSOCIAL_LINKEDIN_PAGE_DROP, plus YSOCIAL_LINKEDIN_PAGE_ADD. A change of
 *   the list happens here, not in the Postiz file.
 * - ID, name and picture of the member come from /v2/me (r_basicprofile,
 *   which the provider already asks for) in the shape of /v2/userinfo.
 *
 * Postiz asks for every scope in the login dialog and needs every one of
 * them granted, so each line here must be part of the Community Management
 * API product (Microsoft Learn, „Increasing Access“, row Community Management
 * API; checked against the docs, not yet against Y Social's app, B6).
 *
 * A change of this list changes what a new login asks for. LinkedIn: „If you
 * request a different scope than the previously granted scope, all the
 * previous access tokens are invalidated“ (Authorization Code Flow). Change
 * it before the first customer page, or plan a new connection of every page.
 *
 * Only "linkedin-page". The provider "linkedin" (personal profiles) keeps
 * openid and profile, it is hidden on our servers (HIDDEN_PROVIDERS).
 */

/** Not part of the Community Management API product. */
export const YSOCIAL_LINKEDIN_PAGE_DROP = ['openid', 'profile'];

/** Comments on page posts, read and reply as the page (inbox, PLAN Phase 3). */
export const YSOCIAL_LINKEDIN_PAGE_ADD = [
  'r_organization_social_feed',
  'w_organization_social_feed',
];

/** The scopes of the Postiz provider without DROP, with ADD, each once. */
export const ysocialLinkedinPageScopes = (postiz: string[]): string[] => [
  ...postiz.filter((scope) => !YSOCIAL_LINKEDIN_PAGE_DROP.includes(scope)),
  ...YSOCIAL_LINKEDIN_PAGE_ADD.filter((scope) => !postiz.includes(scope)),
];

/** What Postiz reads from /v2/userinfo: the member id as sub, name, picture. */
export interface YsocialLinkedinUserinfo {
  sub: string;
  name: string;
  picture?: string;
}

const ME_URL =
  'https://api.linkedin.com/v2/me?projection=(id,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))';

/**
 * The member behind the token from /v2/me, in the shape of /v2/userinfo.
 *
 * The id of /v2/me is the person id, unique to the context of the app
 * (Profile API). That it equals the sub of OpenID Connect is likely (Postiz
 * posts as urn:li:person:<sub>) but not documented; for Y Social's new app it
 * makes no difference. Postiz keeps it as the placeholder linkedin-page_<id>
 * and as rootInternalId of every page chosen from it: the one-time tokens of
 * one login go to all rows with that value (IntegrationRepository).
 *
 * required (authenticate): an answer without an id throws, so no row
 * linkedin-page_undefined can come up and share tokens with other logins
 * (fail-closed). Without it (refreshToken) the tokens still count: Postiz
 * keeps name and picture of the channel there and uses only the tokens.
 * Errors name the status, never the token.
 *
 * The picture is the last one LinkedIn lists, if any; it only stands on the
 * placeholder until the page with its logo is chosen.
 */
export async function ysocialLinkedinUserinfo(
  accessToken: string,
  options: { required?: boolean } = {}
): Promise<YsocialLinkedinUserinfo> {
  const response = await fetch(ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (options.required && !response.ok) {
    throw new Error(`LinkedIn /v2/me answered ${response.status}`);
  }
  const me = await response.json().catch(() => null);
  if (options.required && !(typeof me?.id === 'string' && me.id.trim())) {
    throw new Error('LinkedIn /v2/me answered without an id');
  }

  const images = me?.profilePicture?.['displayImage~']?.elements;
  const picture = Array.isArray(images)
    ? images.at(-1)?.identifiers?.[0]?.identifier
    : undefined;

  return {
    sub: me?.id,
    name: [me?.localizedFirstName, me?.localizedLastName]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join(' '),
    ...(typeof picture === 'string' ? { picture } : {}),
  };
}
