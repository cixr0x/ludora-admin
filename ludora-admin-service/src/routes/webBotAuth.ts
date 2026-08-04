import { Router, type NextFunction, type Request, type Response } from 'express';

import type { WebBotAuthService } from '../webBotAuth/webBotAuthService.js';

export function createPublicWebBotAuthRouter(service: WebBotAuthService): Router {
  const router = Router();

  router.get('/.well-known/http-message-signatures-directory', async (_request, response, next) => {
    try {
      const directory = await service.createDirectoryResponse();
      for (const [name, value] of Object.entries(directory.headers)) {
        response.setHeader(name, value);
      }
      response.status(200);
      response.end(JSON.stringify(directory.body));
    } catch (error) {
      next(error);
    }
  });

  router.get('/crawler', (_request, response) => {
    response
      .status(200)
      .type('html')
      .send(crawlerIdentityHtml(service.identityOrigin, service.contactEmail));
  });

  return router;
}

export function createWebBotAuthSigningRouter(service: WebBotAuthService): Router {
  const router = Router();

  router.post('/', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const url = typeof request.body?.url === 'string' ? request.body.url : '';
      const method = typeof request.body?.method === 'string' ? request.body.method : 'GET';
      if (!url.trim()) {
        response.status(400).json({ error: { message: 'url is required' } });
        return;
      }
      const headers = await service.createRequestHeaders(url, method);
      response.status(200).json({
        data: {
          signature: headers.Signature,
          signature_agent: headers['Signature-Agent'],
          signature_input: headers['Signature-Input']
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function crawlerIdentityHtml(identityOrigin: string, contactEmail: string): string {
  const escapedOrigin = escapeHtml(identityOrigin);
  const escapedEmail = escapeHtml(contactEmail);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ludora Store Collector</title>
  </head>
  <body>
    <main>
      <h1>Ludora Store Collector</h1>
      <p>Ludora collects public board-game product information such as title, price, and availability.</p>
      <p>The collector identifies and authenticates its requests with Web Bot Auth, respects robots.txt, and uses per-store request pacing.</p>
      <p>Identity: <a href="${escapedOrigin}">${escapedOrigin}</a></p>
      <p>Contact: <a href="mailto:${escapedEmail}">${escapedEmail}</a></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
