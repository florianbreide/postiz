/**
 * Extra Meta scopes for the inbox (PR 38, E58). The Postiz providers
 * "facebook" and "instagram" (Instagram API with Facebook Login) add this
 * list to their scopes: ysocial patches 4 and 5 (YSOCIAL-PATCHES.md). Not
 * "instagram-standalone" (Instagram Login): it has no Page and its own
 * permission names (instagram_business_*).
 *
 * Not in the inbox folder on purpose: the Postiz providers also run in the
 * orchestrator, which must not load the inbox (rule 2,
 * ysocial.inbox.no-automation.spec.ts).
 *
 * Postiz asks for every scope of the provider in the login dialog and,
 * after the login, checks that every one of them is granted
 * (SocialAbstract.checkScopes on GET /me/permissions). One missing scope
 * stops the whole connection with NotEnoughScopes (HTTP 409). So each scope
 * here must be grantable by the person who connects: with a role in the app
 * (Standard Access) or, for everyone else, after the App Review (Advanced
 * Access).
 *
 * Channels connected before a change of this list keep their token. They
 * carry a new scope only after they are connected again.
 *
 * pages_read_user_content: delete its line only if the Facebook probe of
 * postiz#15 (QA 10) reads Page comments without it and App Review does not
 * ask for it as a dependency of instagram_basic or pages_manage_engagement
 * (Hub meta.md 2.5, checklist step 11). If Meta refuses Advanced Access for
 * a scope here, its line has to go as well: otherwise nobody without a role
 * in the app can connect Facebook or Instagram.
 */
export const YSOCIAL_META_SCOPES = [
  'pages_read_user_content', // comments of other people on a Page
  'pages_manage_metadata', // webhooks: Page field feed, Instagram comments
];
