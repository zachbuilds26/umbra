// Copies the non-TypeScript runtime files into dist so a deploy that ships only
// the build output can still start. `tsc` emits .js only, so without this the
// migration silently finds no schema and the service falls back to an
// in-memory ledger.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copies = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of copies) {
  const src = join(root, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    console.error(`[build] missing ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[build] copied ${from} -> ${to}`);
}
