import { readFileSync } from 'fs';
import { join } from 'path';

// The block of automatic posts (D15, YsocialModule.configure) hangs on route
// paths and DTO fields of Postiz. A rename upstream would let a repeat or a
// plug through without any error, so this test reads the Postiz sources and
// fails first. It sits with the upstream-sync checks (docs/STAGING-TESTPLAN.md).

const ROOT = join(__dirname, '..', '..', '..', '..');
const source = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const POSTS = 'apps/backend/src/api/routes/posts.controller.ts';
const PUBLIC =
  'apps/backend/src/public-api/routes/v1/public.integrations.controller.ts';
const INTEGRATIONS = 'apps/backend/src/api/routes/integrations.controller.ts';
const DTO = 'libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts';
const UPDATE_SETTINGS_DTO =
  'libraries/nestjs-libraries/src/dtos/posts/update.post.settings.dto.ts';
const REPOSITORY =
  'libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts';

const fix =
  'Postiz hat die Route umbenannt, YsocialModule.configure und YsocialAutomationMiddleware anpassen (Regel 2, D15)';

const expectSource = (file: string, pattern: RegExp, what: string) => {
  const found = pattern.test(source(file));
  if (!found) {
    throw new Error(`${file}: ${what} nicht mehr gefunden. ${fix}.`);
  }
};

// The text of the method that follows a decorator line.
const methodAfter = (file: string, decorator: RegExp) => {
  const text = source(file);
  const match = decorator.exec(text);
  if (!match) {
    throw new Error(`${file}: ${decorator} nicht mehr gefunden. ${fix}.`);
  }
  return text.slice(match.index, match.index + 700);
};

describe('Postiz sources the block of automatic posts relies on', () => {
  it('POST /posts', () => {
    expectSource(POSTS, /@Controller\('\/posts'\)/, "@Controller('/posts')");
    expectSource(POSTS, /@Post\('\/'\)/, "@Post('/')");
  });

  it('POST /public/v1/posts', () => {
    expectSource(
      PUBLIC,
      /@Controller\('\/public\/v1'\)/,
      "@Controller('/public/v1')"
    );
    expectSource(PUBLIC, /@Post\('\/posts'\)/, "@Post('/posts')");
  });

  it('PUT /public/v1/posts/:id/settings takes settings', () => {
    expectSource(
      PUBLIC,
      /@Put\('\/posts\/:id\/settings'\)/,
      "@Put('/posts/:id/settings')"
    );
    const method = methodAfter(PUBLIC, /@Put\('\/posts\/:id\/settings'\)/);
    if (!/UpdatePostSettingsDto/.test(method)) {
      throw new Error(
        `${PUBLIC}: PUT /posts/:id/settings nimmt UpdatePostSettingsDto nicht mehr. YsocialAutomationMiddleware (body.settings) anpassen (Regel 2, D15).`
      );
    }
    if (!/settings: /.test(source(UPDATE_SETTINGS_DTO))) {
      throw new Error(
        `${UPDATE_SETTINGS_DTO}: settings nicht mehr gefunden. YsocialAutomationMiddleware liest body.settings, anpassen (Regel 2, D15).`
      );
    }
  });

  it('POST /integrations/:id/plugs and PUT /integrations/plugs/:id/activate', () => {
    expectSource(
      INTEGRATIONS,
      /@Controller\('\/integrations'\)/,
      "@Controller('/integrations')"
    );
    expectSource(
      INTEGRATIONS,
      /@Post\('\/:id\/plugs'\)/,
      "@Post('/:id/plugs')"
    );
    expectSource(
      INTEGRATIONS,
      /@Put\('\/plugs\/:id\/activate'\)/,
      "@Put('/plugs/:id/activate')"
    );
    const activate = methodAfter(
      INTEGRATIONS,
      /@Put\('\/plugs\/:id\/activate'\)/
    );
    if (!/@Body\('status'\)/.test(activate)) {
      throw new Error(
        `${INTEGRATIONS}: @Body('status') an PUT /plugs/:id/activate fehlt. Postiz hat das Feld geändert, YsocialAutomationMiddleware (status === true) anpassen (Regel 2, D15).`
      );
    }
  });

  it('CreatePostDto has inter and settings per post', () => {
    expectSource(DTO, /\binter\?: number;/, 'inter?: number in CreatePostDto');
    const post = source(DTO)
      .split('export class Post {')[1]
      ?.split('class Tags')[0];
    if (!post || !/\bsettings: /.test(post)) {
      throw new Error(
        `${DTO}: settings je Post nicht mehr gefunden. automatedPost (automation.rules.ts) liest posts[].settings, anpassen (Regel 2, D15).`
      );
    }
  });

  it('createOrUpdatePlug creates the plug as activated', () => {
    const create = methodAfter(REPOSITORY, /createOrUpdatePlug\(/);
    if (!/create: \{[\s\S]*activated: true/.test(create)) {
      throw new Error(
        `${REPOSITORY}: createOrUpdatePlug legt den Plug nicht mehr mit activated: true an. Die Sperre von POST /integrations/:id/plugs prüfen, ob sie noch nötig ist (Regel 2, D15).`
      );
    }
  });
});
