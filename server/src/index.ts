import { buildApp } from './app.js';

const app = await buildApp();
const port = Number(process.env.PORT) || 4000;
await app.listen({ port, host: '0.0.0.0' });
console.log(`🌙 Same Moon server running on port ${port}`);
