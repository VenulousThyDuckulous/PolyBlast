/**
 * The custom domain, kept in exactly one place.
 *
 * GitHub Pages learns about a custom domain from a `CNAME` file sitting in the *published* branch.
 * `dist/` is rebuilt from scratch on every build and `deploy-pages.mjs` force-pushes `gh-pages`, so
 * that file has to be regenerated from this repo copy every time — otherwise the published CNAME
 * would be erased by the next deploy and the site would silently fall back to the github.io address.
 *
 * It lives at the repository root rather than in `public/`: it is deployment metadata, not an asset
 * the page ever loads.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const CNAME_FILE = 'CNAME';

/**
 * Validate a bare hostname: no scheme, no path, no port, no trailing dot.
 * Returns the normalised (lowercased) name, or throws with a readable reason.
 */
export function validateDomain(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('no domain given. Try: npm run domain polyblast.is-a.dev');
  }
  const domain = input.trim().toLowerCase().replace(/\.$/, '');

  if (/^[a-z]+:\/\//.test(input.trim())) {
    throw new Error(`"${input}" includes a protocol. Use the bare host: ${domain.replace(/^[a-z]+:\/\//, '')}`);
  }
  if (/[\/?#\s]/.test(domain)) {
    throw new Error(`"${input}" includes a path or whitespace. Use just the hostname.`);
  }
  if (domain.length > 253) throw new Error('hostname is longer than 253 characters');

  const labels = domain.split('.');
  if (labels.length < 2) {
    throw new Error(`"${domain}" needs at least two labels (e.g. polyblast.is-a.dev or polyblast.gg)`);
  }
  for (const label of labels) {
    if (!/^[a-z0-9-]{1,63}$/.test(label)) {
      throw new Error(`"${label}" is not a valid label: letters, digits and hyphens only, 1-63 chars`);
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      throw new Error(`"${label}" cannot start or end with a hyphen`);
    }
  }
  // GitHub's Let's Encrypt certificates cap the common name at 64 characters.
  if (domain.length >= 64) {
    throw new Error(`"${domain}" is ${domain.length} characters; GitHub Pages needs a certificate name under 64`);
  }
  return domain;
}

/** The configured domain, or null when the site should stay on its github.io address. */
export async function readDomain(root) {
  try {
    const raw = (await fs.readFile(path.join(root, CNAME_FILE), 'utf8')).trim();
    return raw || null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeDomain(root, domain) {
  await fs.writeFile(path.join(root, CNAME_FILE), `${validateDomain(domain)}\n`);
  return domain;
}

export async function clearDomain(root) {
  await fs.rm(path.join(root, CNAME_FILE), { force: true });
}
