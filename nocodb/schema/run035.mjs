// Wrapper: читает креды NocoDB из /app/portal/.runtime.json → env → импортирует миграцию-035.
// APPLY только при DRY_RUN=0 APPLY_CONFIRM=YES.
import fs from 'fs';
const rt = JSON.parse(fs.readFileSync('/app/portal/.runtime.json', 'utf8'));
const url = rt.NC_URL || rt.ncUrl || rt.nocodbUrl || rt.url || rt.NOCODB_URL;
const token = rt.NC_TOKEN || rt.ncToken || rt.nocodbToken || rt.token || rt.xcAuth || rt.NOCODB_TOKEN;
if (!url || !token) {
  console.error('MISSING creds; runtime keys =', Object.keys(rt).join(','));
  process.exit(2);
}
process.env.NC_URL = url;
process.env.NC_TOKEN = token;
console.log('creds loaded (url=' + url + '), APPLY=' + (process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES'));
await import('./migrate-035-metal.mjs');
