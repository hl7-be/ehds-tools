/**
 * Helpers for a GitHub repository holding a FHIR IG (SUSHI / IG Publisher layout).
 */

/** Parse https://github.com/<owner>/<repo>[/tree/<ref>] (with or without trailing slash or .git). */
export function parseGitHubUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (u.hostname !== 'github.com') {
    throw new Error(`Only github.com repositories are supported (got ${u.hostname})`);
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`Expected https://github.com/<owner>/<repo>, got ${url}`);
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  const ref = parts[2] === 'tree' && parts.length > 3 ? parts.slice(3).join('/') : null;
  return { owner, repo, ref };
}

/**
 * Candidate URLs of the published package.tgz for a repository and branch,
 * most specific first. build.fhir.org builds every branch it is notified about;
 * GitHub Pages only holds the default branch.
 */
export function publishedPackageUrls({ owner, repo, ref, defaultBranch }) {
  const isDefault = ref == null || ref === defaultBranch || (!defaultBranch && ['main', 'master'].includes(ref));
  const ci = `https://build.fhir.org/ig/${owner}/${repo}`;
  if (!isDefault) return [`${ci}/branches/${ref}/package.tgz`];
  return [`${ci}/package.tgz`, `https://${owner.toLowerCase()}.github.io/${repo}/package.tgz`];
}

export function sourceTarballUrl({ owner, repo, ref }) {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref ?? 'HEAD')}`;
}

/** Repository default branch and the commit the ref points to. Soft-fails (returns nulls) without network or on rate limits. */
export async function repoInfo({ owner, repo, ref }, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ehds-tools' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const info = { defaultBranch: null, commit: null, warning: null };
  try {
    const r = await fetchImpl(api, { headers });
    if (!r.ok) throw new Error(`${api}: HTTP ${r.status}`);
    info.defaultBranch = (await r.json()).default_branch;
    const c = await fetchImpl(`${api}/commits/${encodeURIComponent(ref ?? info.defaultBranch)}`, { headers });
    if (!c.ok) throw new Error(`commit lookup: HTTP ${c.status}`);
    const commit = await c.json();
    info.commit = { sha: commit.sha, date: commit.commit?.committer?.date ?? null, message: firstLine(commit.commit?.message) };
  } catch (err) {
    info.warning = `GitHub API unavailable (${err.message}); continuing without commit information`;
  }
  return info;
}

function firstLine(s) {
  return s ? s.split('\n')[0] : null;
}
