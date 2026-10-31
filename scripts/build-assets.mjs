// Copies the public storefront files (root HTML + images) into dist/, the only folder the
// Worker serves as static assets. Keeps server code, config and secrets out of the public site.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

const PUBLIC = /\.(html|png|jpe?g|webp|gif|svg|ico|css|txt|xml|webmanifest)$/i;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
const files = readdirSync('.', { withFileTypes: true }).filter(f => f.isFile() && PUBLIC.test(f.name));
for (const f of files) cpSync(f.name, `dist/${f.name}`);
console.log(`Copied ${files.length} public files to dist/: ${files.map(f => f.name).join(', ')}`);
