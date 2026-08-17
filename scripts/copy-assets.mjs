// The web interface is served as plain files with no bundler, so tsc leaves
// them behind. Copy them next to the compiled server that resolves them.
import { cp } from 'node:fs/promises';

await cp('src/web/public', 'dist/web/public', { recursive: true });
console.log('Copied web assets to dist/web/public');
