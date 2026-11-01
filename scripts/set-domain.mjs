/**
 * Point the published site at its own domain.
 *
 *   npm run domain polyblast.is-a.dev     set (or change) the domain
 *   npm run domain -- --clear             go back to the github.io address
 *
 * This writes the `CNAME` file at the repo root and nothing else. The next `npm run deploy` copies
 * it into the published branch, which is what makes GitHub Pages serve the domain and provision its
 * certificate.
 *
 * ORDER MATTERS — read this before deploying. As soon as a CNAME is published, Pages serves the site
 * at that domain *instead of* https://<user>.github.io/<repo>/. If the domain does not resolve yet,
 * the old address stops working too and the game is unreachable until DNS catches up. So:
 *
 *   1. get the domain's DNS pointing here (for is-a.dev that means the PR is merged);
 *   2. npm run deploy;
 *   3. tick "Enforce HTTPS" in Settings -> Pages once the certificate is issued.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDomain, writeDomain, clearDomain } from './domain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function originRepo() {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(res.stdout.trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const repo = originRepo();
  const pagesHost = repo ? `${repo.owner.toLowerCase()}.github.io` : '<user>.github.io';

  if (args.includes('--clear') || args.includes('-c')) {
    await clearDomain(ROOT);
    console.log('CNAME removed — the next deploy goes back to the github.io address.');
    console.log('Also clear the custom domain in Settings -> Pages, or Pages keeps serving it.');
    return;
  }

  const previous = await readDomain(ROOT);
  const domain = await writeDomain(ROOT, args[0]);

  console.log(`\ndomain set to ${domain}  (written to ${path.relative(ROOT, path.join(ROOT, 'CNAME'))})\n`);
  if (previous && previous !== domain) console.log(`  (replaced the previous "${previous}")\n`);

  console.log('Next steps, in this order:\n');
  console.log(`  1. DNS. The domain needs a CNAME record pointing at ${pagesHost}`);
  console.log('     (no repo name, no https://). If you went through is-a.dev or js.org, your');
  console.log('     pull request *is* the record — nothing to do here.');
  console.log('');
  console.log('  2. Wait for it to resolve:');
  console.log(`       nslookup ${domain}`);
  console.log('');
  console.log('  3. Publish. Only now, or the live site goes dark until DNS catches up:');
  console.log('       npm run deploy');
  console.log('');
  console.log('  4. Settings -> Pages -> tick "Enforce HTTPS". GitHub issues the certificate');
  console.log('     automatically once the domain resolves; it can take up to 24 hours.');
  console.log('');
  console.log('  Optional but worth it: verify the domain in Settings -> Pages first and add the');
  console.log('  TXT record it gives you, so nobody else can claim this domain on GitHub.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
