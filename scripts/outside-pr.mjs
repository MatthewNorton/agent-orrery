// The `tooling review` check on outside pull requests: ones from a fork, or by anyone other than
// the owner or Dependabot (AGENTS.md, "Outside pull requests and issues"). needsReview() decides
// which files the owner reviews before anyone checks out or runs such a pull request.
//
//   node scripts/outside-pr.mjs <n>               is pull request <n> outside, and which files need review
//   node scripts/outside-pr.mjs --ci [--dry-run]  the check (.github/workflows/outside-pr.yml); --dry-run prints its writes

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'MatthewNorton';
const TRUSTED = new Set([OWNER, 'dependabot[bot]']);
const CONTEXT = 'tooling review';
const TOUCHES = 'touches-tooling';
export const REVIEWED = 'tooling-reviewed';
const MARKER = '<!-- outside-pr-guard -->';
const API_FILE_CAP = 3000;
const LISTED = 50;

// The app's source, docs and assets, and the root docs, change without a review. Agent instructions,
// package manifests, dot files and folders, and VS Code workspaces need one wherever they are.
const FREE_ROOTS = ['src', 'docs', 'assets'];
const FREE_FILES = ['readme.md', 'license', 'citation.cff', 'contributing.md', 'security.md'];
const ALWAYS = ['agents.md', 'agents.override.md', 'agent.md', 'claude.md', 'claude.local.md', 'gemini.md',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'node_modules'];

/** @param {string} file @returns {boolean} whether the owner reviews it before anyone runs the pull request */
export function needsReview(file) {
  // Windows and macOS checkouts ignore case, and Windows drops trailing dots and spaces.
  const parts = file.replace(/\\/g, '/').toUpperCase().toLowerCase().split('/').map((part) => part.replace(/[. ]+$/, ''));
  if (parts.some((part) => part === '' || part.startsWith('.') || ALWAYS.includes(part) || part.endsWith('.code-workspace'))) return true;
  return parts.length === 1 ? !FREE_FILES.includes(parts[0]) : !FREE_ROOTS.includes(parts[0]);
}

/**
 * The files in a pull request that need the owner's review, renamed-from paths included. A list the
 * API cut short counts as one more.
 * @param {{ filename: string, previous_filename?: string }[]} files  GET /pulls/{n}/files
 * @param {number} changedFiles  the pull request's changed_files
 */
export function filesToReview(files, changedFiles) {
  const found = files.flatMap((f) => [f.filename, f.previous_filename]).filter((file) => file && needsReview(file));
  if (files.length < changedFiles || files.length >= API_FILE_CAP) found.push('(files the API did not list)');
  return found;
}

const fromFork = (pr) => pr.head?.repo?.full_name !== pr.base?.repo?.full_name;

/** @param {any} pr  a pull request from the API or an event; a deleted fork has no head repo */
export const isOutside = (pr) => fromFork(pr) || !TRUSTED.has(pr.user?.login);

/** Label events other than the review label, and edits that keep the base branch, change nothing. */
export const relevant = (event) => (!['labeled', 'unlabeled'].includes(event.action) || event.label?.name === REVIEWED) &&
  (event.action !== 'edited' || Boolean(event.changes?.base));

/**
 * The check's state. Only the owner's own `labeled` event approves, and only while the label is on.
 * @param {{ action?: string, label?: { name: string }, sender?: { login: string }, pull_request: any }} event
 * @param {string[]} flagged  filesToReview() of the pull request
 * @param {Set<string>} [labels]  the pull request's labels now
 */
export function decide(event, flagged, labels = new Set()) {
  if (!isOutside(event.pull_request)) return { state: 'success', description: 'Owner or Dependabot pull request' };
  if (!flagged.length) return { state: 'success', description: 'No files that need the owner\'s review' };
  if (event.action === 'labeled' && event.label?.name === REVIEWED && event.sender?.login === OWNER && labels.has(REVIEWED)) {
    return { state: 'success', description: `The owner reviewed ${event.pull_request.head.sha.slice(0, 7)}`, reviewed: true };
  }
  return { state: 'failure', description: `Changes files the owner reviews first; the ${REVIEWED} label clears it` };
}

// File names come from the pull request: no backticks, control or direction characters reach output.
const safe = (text) => text.replace(/[\u0000-\u001f\u007f`\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?');

/** @param {string[]} flagged */
export function commentBody(flagged) {
  if (!flagged.length) return `${MARKER}\nThis pull request no longer changes files that need the owner's review, so \`${CONTEXT}\` passes.`;
  const lines = flagged.slice(0, LISTED).map((file) => `- \`${safe(file)}\``);
  if (flagged.length > LISTED) lines.push(`- and ${flagged.length - LISTED} more`);
  return [
    MARKER,
    'This pull request changes agent instructions, tooling or configuration, or files outside `src/`, `docs/` and `assets/`:',
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
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!relevant(event)) return console.log(`Nothing to check on this ${event.action} event.`);
  const repo = process.env.GITHUB_REPOSITORY;
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
    const flagged = filesToReview(files, now.changed_files);
    const labels = new Set(now.labels.map((label) => label.name));
    const verdict = decide(event, flagged, labels);
    if (labels.has(REVIEWED) && !verdict.reviewed) send(`${issue}/labels/${REVIEWED}`, { method: 'DELETE' });
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
  const flagged = filesToReview(listFiles(repo, number), pr.changed_files);
  console.log(`#${number} by ${pr.user.login}${fromFork(pr) ? ' from a fork' : ''}: ${isOutside(pr) ? 'OUTSIDE' : 'not outside'}`);
  for (const file of flagged) console.log(`  ${safe(file)}`);
  if (!flagged.length) console.log('  no files that need the owner\'s review');
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
