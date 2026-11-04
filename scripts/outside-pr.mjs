// Outside pull requests (AGENTS.md, "Outside pull requests and issues"): one from a fork, or by
// anyone other than the owner or Dependabot. TOOLING lists the files such a pull request must not
// change unreviewed: text coding agents follow, and code that runs at install, test, gate, or
// editor and agent startup. The `tooling review` check (.github/workflows/outside-pr.yml) runs
// main's copy of this file and never the pull request's code.
//
//   node scripts/outside-pr.mjs <n>               is pull request <n> outside, and which listed files it changes
//   node scripts/outside-pr.mjs --ci [--dry-run]  the check itself; --dry-run prints its writes instead

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER = 'MatthewNorton';
const TRUSTED = new Set([OWNER, 'dependabot[bot]']);
export const CONTEXT = 'tooling review';
export const TOUCHES = 'touches-tooling';
export const REVIEWED = 'tooling-reviewed';
const MARKER = '<!-- outside-pr-guard -->';
const API_FILE_CAP = 3000;
const LISTED = 50;

// Lowercase. An entry ending in `/` is a folder and everything in it; any other entry is a file.
export const TOOLING = [
  {
    why: 'agent instructions',
    root: ['kit/', 'goals.md'],
    anyDepth: ['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', '.claude/', '.codex/'],
  },
  {
    why: 'tooling',
    root: ['scripts/', 'test/', '.github/', 'install agent orrery.cmd', 'install agent orrery.command'],
    anyDepth: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.yarnrc', '.yarnrc.yml',
      '.pnpmfile.cjs', 'node_modules/', '.mcp.json', '.vscode/', '.devcontainer/', '.devcontainer.json'],
  },
];

// Windows and macOS checkouts ignore case, and Windows drops trailing dots and spaces.
const normalize = (file) => file.replace(/\\/g, '/').split('/').map((part) => part.replace(/[. ]+$/, '')).join('/').toLowerCase();

function matches(file, entry, anyDepth) {
  if (entry.endsWith('/')) return anyDepth ? `/${file}`.includes(`/${entry}`) : file.startsWith(entry);
  return anyDepth ? `/${file}`.endsWith(`/${entry}`) : file === entry;
}

/** @param {string} file @returns {string | null} why the file needs the owner's review, if it does */
export function toolingReason(file) {
  const name = normalize(file);
  const group = TOOLING.find((g) => g.root.some((e) => matches(name, e, false)) || g.anyDepth.some((e) => matches(name, e, true)));
  return group ? group.why : null;
}

/**
 * The listed files a pull request changes, renamed-from paths included. A list the API cut short
 * counts as one more file to review.
 * @param {{ filename: string, previous_filename?: string }[]} files  GET /pulls/{n}/files
 * @param {number} changedFiles  the pull request's changed_files
 */
export function toolingFiles(files, changedFiles) {
  const found = files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean)
    .map((file) => ({ file, why: toolingReason(file) })).filter((f) => f.why);
  if (files.length < changedFiles || files.length >= API_FILE_CAP) found.push({ file: `${changedFiles} files`, why: 'the API did not list them all' });
  return found;
}

/** @param {any} pr  a pull request from the API or an event; a deleted fork has no head repo */
export function isOutside(pr) {
  return pr.head?.repo?.full_name !== pr.base?.repo?.full_name || !TRUSTED.has(pr.user?.login);
}

/**
 * The check's state. Only the owner's own `labeled` event approves, and only while the label is on.
 * @param {{ action?: string, label?: { name: string }, sender?: { login: string }, pull_request: any }} event
 * @param {{ file: string, why: string }[]} flagged  toolingFiles() of the pull request
 */
export function decide(event, flagged) {
  const pr = event.pull_request;
  if (!isOutside(pr)) return { state: 'success', description: 'Owner or Dependabot pull request' };
  if (!flagged.length) return { state: 'success', description: 'No agent or tooling files changed' };
  const reviewed = event.action === 'labeled' && event.label?.name === REVIEWED && event.sender?.login === OWNER &&
    pr.labels?.some((label) => label.name === REVIEWED);
  return reviewed
    ? { state: 'success', description: `The owner reviewed the tooling changes at ${pr.head.sha.slice(0, 7)}` }
    : { state: 'failure', description: `Changes agent or tooling files; the owner reviews them, then adds ${REVIEWED}` };
}

// File names come from the pull request: no backticks, control or direction characters reach output.
const safe = (text) => String(text).replace(/[\u0000-\u001f\u007f`‎‏‪-‮⁦-⁩]/g, '?');

/** @param {{ file: string, why: string }[]} flagged */
export function commentBody(flagged) {
  if (!flagged.length) return `${MARKER}\nThis pull request no longer changes agent or tooling files, so \`${CONTEXT}\` passes.`;
  const lines = flagged.slice(0, LISTED).map(({ file, why }) => `- \`${safe(file)}\` (${why})`);
  if (flagged.length > LISTED) lines.push(`- and ${flagged.length - LISTED} more`);
  return [
    MARKER,
    'This pull request changes files that coding agents follow, or that run at install, test, gate, CI, or editor and agent startup:',
    '',
    ...lines,
    '',
    `The owner reviews them on GitHub before anyone checks out or runs this branch. After reviewing the latest commit, the owner adds the \`${REVIEWED}\` label, which clears \`${CONTEXT}\`; a new push or base branch takes it off again.`,
  ].join('\n');
}

function gh(route, { method = 'GET', body = undefined, pages = false } = {}) {
  const args = ['api', '-X', method, route, ...(pages ? ['--paginate', '--slurp'] : []), ...(body ? ['--input', '-'] : [])];
  const out = execFileSync('gh', args, { encoding: 'utf8', input: body && JSON.stringify(body), maxBuffer: 256 * 1024 * 1024 });
  const data = out.trim() ? JSON.parse(out) : null;
  return pages ? data.flat() : data;
}

const listFiles = (repo, number) => gh(`repos/${repo}/pulls/${number}/files?per_page=100`, { pages: true });

function runCheck(dryRun) {
  const event = JSON.parse(fs.readFileSync(String(process.env.GITHUB_EVENT_PATH), 'utf8'));
  const repo = String(process.env.GITHUB_REPOSITORY);
  const { number, head, base } = event.pull_request;
  const issue = `repos/${repo}/issues/${number}`;
  const send = dryRun ? (route, { method, body }) => console.log(method, route, body ? JSON.stringify(body) : '') : gh;
  const status = ({ state, description }) => send(`repos/${repo}/statuses/${head.sha}`, {
    method: 'POST',
    body: { state, description, context: CONTEXT, target_url: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` },
  });
  try {
    if (!isOutside(event.pull_request)) return status(decide(event, []));
    const files = listFiles(repo, number);
    const now = gh(`repos/${repo}/pulls/${number}`);
    if (now.head.sha !== head.sha || now.base.ref !== base.ref) return console.log('The pull request moved; the run for its new state decides.');
    const flagged = toolingFiles(files, now.changed_files);
    const verdict = decide({ ...event, pull_request: { ...event.pull_request, labels: now.labels } }, flagged);
    const labels = new Set(now.labels.map((label) => label.name));
    if (labels.has(REVIEWED) && !(flagged.length && verdict.state === 'success')) send(`${issue}/labels/${REVIEWED}`, { method: 'DELETE' });
    if (flagged.length && !labels.has(TOUCHES)) send(`${issue}/labels`, { method: 'POST', body: { labels: [TOUCHES] } });
    if (!flagged.length && labels.has(TOUCHES)) send(`${issue}/labels/${TOUCHES}`, { method: 'DELETE' });
    const body = commentBody(flagged);
    const mine = gh(`${issue}/comments?per_page=100`, { pages: true })
      .find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
    if (mine && mine.body !== body) send(`repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
    if (!mine && flagged.length) send(`${issue}/comments`, { method: 'POST', body: { body } });
    status(verdict);
  } catch (error) {
    console.error(error);
    status({ state: 'failure', description: 'The check could not finish; re-run it' });
    process.exit(1);
  }
}

function report(number) {
  const repo = process.env.GITHUB_REPOSITORY || `${OWNER}/agent-orrery`;
  const pr = gh(`repos/${repo}/pulls/${number}`);
  const flagged = toolingFiles(listFiles(repo, number), pr.changed_files);
  const fork = pr.head?.repo?.full_name === pr.base.repo.full_name ? '' : ' from a fork';
  console.log(`#${number} by ${safe(pr.user.login)}${fork}: ${isOutside(pr) ? 'OUTSIDE' : 'not outside'}`);
  for (const { file, why } of flagged) console.log(`  ${safe(file)}  (${why})`);
  if (!flagged.length) console.log('  changes no agent or tooling files');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const first = process.argv[2] ?? '';
  if (first === '--ci') runCheck(process.argv.includes('--dry-run'));
  else if (/^\d+$/.test(first)) report(Number(first));
  else {
    console.error('usage: node scripts/outside-pr.mjs <pull request number> | --ci [--dry-run]');
    process.exit(2);
  }
}
