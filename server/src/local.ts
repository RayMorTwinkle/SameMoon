// Single-origin entry point for the standalone local image.
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';

const app = await buildApp();
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../../client/dist/', import.meta.url)),
});
// Direct links and reloads on the two browser routes need the SPA shell.
for (const route of ['/room/:code', '/room/:code/play']) {
  app.get(route, (_req, reply) => reply.sendFile('index.html'));
}
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT) || 3000 });
