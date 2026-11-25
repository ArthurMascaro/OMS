import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  // The Playground has no setting to hide its type-hint popover.
  app.use(
    '/graphql',
    (request: Request, response: Response<string>, next: NextFunction) => {
      if (request.method !== 'GET' || !request.accepts('html')) {
        return next();
      }

      const send = response.send.bind(response);
      response.send = (body) => {
        const playgroundHtml =
          typeof body === 'string' && body.includes('id="playground-config"')
            ? body.replace(
                '</head>',
                '<style>.CodeMirror-hint-information{display:none!important}</style></head>',
              )
            : body;
        return send(playgroundHtml);
      };

      return next();
    },
  );

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
