import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
copyFileSync(fileURLToPath(new URL('wrangler.production.toml', root)), fileURLToPath(new URL('wrangler.toml', root)));
console.log('Production configuration prepared; Worker secrets remain in Cloudflare.');
