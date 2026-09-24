/**
 * Pull every Umbra asset logo local: frontend/assets/tokens/{SYMBOL}.{png,svg}
 * + manifest.json { SYMBOL: "file" }. Run: npx tsx scripts/fetch-logos.ts
 * Requires the backend on :3002 (source of the logo URLs).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const API = process.env.UMBRA_API ?? 'http://localhost:3002';
const OUT = path.resolve(process.cwd(), 'frontend', 'assets', 'tokens');

interface Asset {
  symbol: string;
  logo?: string;
}

function extOf(url: string): string {
  const clean = url.split('?')[0] ?? url;
  if (clean?.toLowerCase().endsWith('.svg')) return '.svg';
  if (clean?.toLowerCase().endsWith('.webp')) return '.webp';
  return '.png';
}

async function download(url: string, dest: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return false; // error page, not an image
    await fs.writeFile(dest, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await fs.mkdir(OUT, { recursive: true });
  const res = await fetch(`${API}/api/assets`);
  if (!res.ok) throw new Error(`GET /api/assets -> ${res.status}`);
  const { assets } = (await res.json()) as { assets: Asset[] };
  const manifest: Record<string, string> = {};
  let ok = 0;
  let missing = 0;
  const failed: string[] = [];

  // Gentle concurrency (5) to respect upstream CDNs.
  const queue = assets.filter((a) => a.logo);
  missing = assets.length - queue.length;
  for (let i = 0; i < queue.length; i += 5) {
    const batch = queue.slice(i, i + 5);
    // One failed download must not abort the whole run: the symbol is recorded
    // as failed and the script continues. Promise.all without a catch here
    // rejected on the first network error and wrote no manifest at all.
    const results = await Promise.all(
      (batch as Asset[]).map(async (a) => {
        const asset = a as Asset;
        // Symbol comes from the provider, so it is never trusted as a filename.
        const safeSymbol = String(asset.symbol).replace(/[^A-Za-z0-9._-]/g, '_');
        const file = `${safeSymbol}${extOf(asset.logo as string)}`;
        const good = await download(asset.logo as string, path.join(OUT, file)).catch(() => false);
        return { symbol: asset.symbol, file, good };
      }),
    );
    for (const r of results) {
      if (r.good) {
        manifest[r.symbol] = r.file;
        ok++;
      } else {
        failed.push(r.symbol);
      }
    }
    process.stdout.write(`\r${ok}/${queue.length} downloaded...`);
  }
  console.log(`\ndone: ${ok} ok, ${missing} without logo URL, ${failed.length} failed`);
  if (failed.length > 0) console.log('failed:', failed.join(', '));
  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('manifest.json written');
}

// A rejection here means the assets endpoint was unreachable; say so with a
// non-zero exit instead of an unhandled promise warning.
void main().catch((err: unknown) => {
  console.error('[logos] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
