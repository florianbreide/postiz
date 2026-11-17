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
 * API product. Channels connected before a change keep their token: they
 * carry a new scope only after they are connected again.
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
 * The person id of /v2/me is the sub of OpenID Connect (urn:li:person:<id>).
 * The picture is the largest one LinkedIn lists, if any.
 */
export async function ysocialLinkedinUserinfo(
  accessToken: string
): Promise<YsocialLinkedinUserinfo> {
  const me = await (
    await fetch(ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  ).json();

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
