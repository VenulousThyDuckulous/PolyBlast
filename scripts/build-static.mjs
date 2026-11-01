/**
 * Build a self-contained static bundle for GitHub Pages (or any plain file host).
 *
 * The game normally runs behind the Node server in server/index.js, which serves three.js out of
 * node_modules and talks to the client over a WebSocket. Neither is possible on static hosting, so
 * this copies every file the page actually needs into one directory with a flat, relative layout:
 *
 *   dist/index.html          the page
 *   dist/style.css
 *   dist/js/*.js             client modules
 *   dist/shared/*.js         protocol + avatar model
 *   dist/server/*.js         the sim, so the match can run in the browser
 *   dist/vendor/three/*      the three.js ESM build
 *
 * Everything is referenced relatively, which is what lets the same bundle work at a
 * https://user.github.io/RepoName/ subpath as well as at a domain root.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDomain, CNAME_FILE } from './domain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');

/** Only the sim modules the browser imports; server/index.js stays out. */
const SERVER_FILES = ['config.js', 'world.js', 'bots.js', 'sim.js'];

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else if (entry.isFile()) await fs.copyFile(src, dest);
  }
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  await copyDir(path.join(ROOT, 'public'), OUT);

  // Everything shared between client and server (protocol, avatar model).
  await copyDir(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));

  await fs.mkdir(path.join(OUT, 'server'), { recursive: true });
  for (const file of SERVER_FILES) {
    await fs.copyFile(path.join(ROOT, 'server', file), path.join(OUT, 'server', file));
  }

  // The whole build directory: three.module.js re-exports from three.core.js in recent releases.
  await copyDir(path.join(ROOT, 'node_modules', 'three', 'build'), path.join(OUT, 'vendor', 'three'));

  // Keep Jekyll's fingers off the output.
  await fs.writeFile(path.join(OUT, '.nojekyll'), '');

  // A published CNAME file is what makes Pages serve the custom domain, and deploy-pages.mjs
  // force-pushes a branch rebuilt from this directory — so the file is re-created from the repo
  // copy on every build, or the domain would be dropped by the next deploy.
  const domain = await readDomain(ROOT);
  if (domain) await fs.writeFile(path.join(OUT, CNAME_FILE), `${domain}\n`);

  // Tells the client it is a static bundle: no server to join, so the match runs in the page.
  // Stamped into the HTML so the decision costs no request.
  const indexPath = path.join(OUT, 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  const tagged = html.replace(
    '</head>',
    '  <meta name="polyblast-mode" content="offline" />\n  </head>',
  );
  if (tagged === html) throw new Error('could not stamp the offline marker into index.html');
  await fs.writeFile(indexPath, tagged);

  // Also available as a file for anything that wants to check from outside the page.
  await fs.writeFile(
    path.join(OUT, 'offline.json'),
    `${JSON.stringify(
      {
        mode: 'offline',
        note: 'Static build. The match is simulated in your browser; there is no multiplayer server.',
      },
      null,
      2,
    )}\n`,
  );

  const report = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else report.push(full);
    }
  }
  await walk(OUT);
  const bytes = (
    await Promise.all(report.map(async (f) => (await fs.stat(f)).size))
  ).reduce((a, b) => a + b, 0);

  console.log(`static build: ${report.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB -> ${path.relative(ROOT, OUT)}`);
  if (domain) console.log(`  custom domain: ${domain} (${CNAME_FILE} written)`);
  else console.log('  no domain configured — the site is served from its github.io address');
  console.log('  open index.html over http (file:// blocks ES modules)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
