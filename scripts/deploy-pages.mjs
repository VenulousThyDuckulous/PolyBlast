/**
 * Publish dist/ to the repository's gh-pages branch.
 *
 * Built with plain git plumbing on purpose: no gh-pages package, no CI minutes, no extra dependency.
 * The contents of dist/ become the root of the branch, which is what GitHub Pages serves.
 *
 *   npm run deploy
 *
 * Authentication goes through the gh CLI's credential helper, so no token is written anywhere.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, '.deploy');
const BRANCH = 'gh-pages';

function git(args, cwd = ROOT, extra = []) {
  const res = spawnSync('git', [...extra, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else if (entry.isFile()) await fs.copyFile(src, dest);
  }
}

async function main() {
  try {
    await fs.access(path.join(DIST, 'index.html'));
  } catch {
    throw new Error('No dist/ build found. Run "npm run build" first.');
  }

  const remote = git(['remote', 'get-url', 'origin']);
  console.log(`publishing dist/ to ${remote} (${BRANCH})`);

  await fs.rm(STAGE, { recursive: true, force: true });
  await copyDir(DIST, STAGE);

  git(['init', '-q'], STAGE);
  git(['checkout', '-q', '-b', BRANCH], STAGE);
  git(['add', '-A'], STAGE);

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  git(['commit', '-q', '-m', `Deploy ${stamp}`], STAGE, [
    '-c', 'user.name=deploy',
    '-c', 'user.email=deploy@localhost',
  ]);

  // Force-push: the branch is generated output, not history worth keeping.
  git(['push', '--force', remote, `${BRANCH}:${BRANCH}`], STAGE, [
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!gh auth git-credential',
  ]);

  await fs.rm(STAGE, { recursive: true, force: true });
  console.log(`done. enable Pages (branch: ${BRANCH}, folder: /) in the repo settings.`);
}

main().catch(async (err) => {
  await fs.rm(STAGE, { recursive: true, force: true }).catch(() => {});
  console.error(err.message);
  process.exit(1);
});
