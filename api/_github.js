// Reads and writes a file in the GitHub repo, so saved prices become a normal
// commit (with history and undo) and Vercel redeploys the site automatically.
//
// Needs GITHUB_TOKEN in Vercel: a fine-grained token with "Contents: Read and
// write" access to this repository only.

const REPO = process.env.GITHUB_REPO || 'jmd8324/grocery-saver';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

export const githubConfigured = Boolean(process.env.GITHUB_TOKEN);

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CartCompare',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function readFile(path) {
  const { status, data } = await gh(`${path}?ref=${encodeURIComponent(BRANCH)}`);
  if (status !== 200) throw Object.assign(new Error(`GitHub read ${status}: ${data.message || ''}`), { status });
  return { text: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

export async function writeFile(path, text, sha, message) {
  const { status, data } = await gh(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), sha, branch: BRANCH }),
  });
  if (status !== 200 && status !== 201) throw Object.assign(new Error(`GitHub write ${status}: ${data.message || ''}`), { status });
  return data.commit && data.commit.html_url;
}
