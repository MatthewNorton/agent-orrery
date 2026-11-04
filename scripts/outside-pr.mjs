// The `tooling review` check on outside pull requests: ones from a fork, or by anyone other than
// the owner or Dependabot (AGENTS.md, "Outside pull requests and issues"). needsReview() decides
// which files the owner reviews before anyone checks out such a pull request or opens it in an
// agent. An owner comment that is only `/tooling-reviewed <full SHA>` approves the commit it names.
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
const LABEL = 'touches-tooling';
const COMMAND = '/tooling-reviewed';
const APPROVAL = /^[ \t\r\n]*\/tooling-reviewed[ \t]+([0-9a-f]{40})[ \t\r\n]*$/;
const MARKER = '<!-- outside-pr-guard -->';
const API_FILE_CAP = 3000;
const LISTED = 50;
const NAME_CHARS = 200;

// The app's source, docs and assets, and the root docs, change without a review. Agent instructions,
// package manifests, dot files and folders, and VS Code workspaces need one wherever they are.
const FREE_ROOTS = ['src', 'docs', 'assets'];
const FREE_FILES = ['readme.md', 'license', 'citation.cff', 'contributing.md', 'security.md'];
const ALWAYS = ['agents.md', 'agents.override.md', 'agent.md', 'claude.md', 'claude.local.md', 'gemini.md',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'node_modules'];

/** @param {string} file @returns {boolean} whether the owner reviews it before anyone runs the pull request */
export function needsReview(file) {
  // Windows and macOS checkouts ignore case, Windows drops trailing dots and spaces and answers to
  // 8.3 short names (CLAUDE~1), and a non-ASCII name can fold onto a listed one: those need review.
  if (/[^\x20-\x7e]|~\d/.test(file)) return true;
  const parts = file.replace(/\\/g, '/').toLowerCase().split('/').map((part) => part.replace(/[. ]+$/, ''));
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

/** Pull request events, except edits that keep the base, and owner comments that add or drop an approval. */
export function relevant(event) {
  if (!event.comment) return event.action !== 'edited' || Boolean(event.changes?.base);
  const bodies = [event.comment.body, event.changes?.body?.from];
  return Boolean(event.issue?.pull_request) && event.comment.user?.login === OWNER && bodies.some((body) => body?.includes(COMMAND));
}

/** The comments with the event's copy of the one it is about, since the list can lag behind an edit or a delete. */
export function withEvent(comments, event) {
  if (!event.comment) return comments;
  const rest = comments.filter((c) => c.id !== event.comment.id);
  return event.action === 'deleted' ? rest : [...rest, event.comment];
}

/** @param {{ user?: { login?: string }, body?: string }[]} comments @returns {Set<string>} commits the owner approved */
export const approvals = (comments) => new Set(comments.filter((c) => c.user?.login === OWNER)
  .flatMap((c) => APPROVAL.exec(c.body ?? '')?.[1] ?? []));

/**
 * The check's state for a pull request at its head commit; `approved` marks a pass that rests on the
 * owner's approval.
 * @param {any} pr
 * @param {string[]} flagged  filesToReview() of it
 * @param {Set<string>} [approved]  approvals() of its comments
 */
export function decide(pr, flagged, approved = new Set()) {
  if (!isOutside(pr)) return { state: 'success', description: 'Owner or Dependabot pull request' };
  if (!flagged.length) return { state: 'success', description: 'No files that need the owner\'s review' };
  if (approved.has(pr.head.sha)) return { state: 'success', description: `The owner reviewed ${pr.head.sha.slice(0, 7)}`, approved: true };
  return { state: 'failure', description: 'Changes files the owner reviews first; the comment on the pull request says how to approve' };
}

// File names come from the pull request: keep printable ASCII other than backticks, and shorten them.
function safe(text) {
  const ascii = text.replace(/[^\x20-\x7e]|`/gu, '?');
  return ascii.length > NAME_CHARS ? `${ascii.slice(0, NAME_CHARS)}...` : ascii;
}

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
    'The owner reviews them on GitHub before anyone checks out this branch or opens it in a coding agent.',
    `To approve, the owner comments only \`${COMMAND} <full SHA>\`, with the SHA of the commit they read. A new push needs a new approval.`,
  ].join('\n');
}

function gh(route, { method = 'GET', body = undefined, pages = false } = {}) {
  const args = ['api', '-X', method, route, ...(pages ? ['--paginate', '--slurp'] : []), ...(body ? ['--input', '-'] : [])];
  const out = execFileSync('gh', args, { encoding: 'utf8', input: body && JSON.stringify(body), maxBuffer: 256 * 1024 * 1024 });
  const data = out.trim() ? JSON.parse(out) : null;
  return pages ? data.flat() : data;
}

const getPull = (repo, number) => gh(`repos/${repo}/pulls/${number}`);
const listFiles = (repo, number) => gh(`repos/${repo}/pulls/${number}/files?per_page=100`, { pages: true });

function runCheck(dryRun) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!relevant(event)) return console.log('Nothing to check for this event.');
  const repo = process.env.GITHUB_REPOSITORY;
  const number = event.pull_request?.number ?? event.issue.number;
  const first = event.pull_request ?? getPull(repo, number);
  if (first.base.ref !== event.repository?.default_branch) return console.log('Not a pull request into the default branch.');
  const issue = `repos/${repo}/issues/${number}`;
  const listComments = () => gh(`${issue}/comments?per_page=100`, { pages: true });
  const send = dryRun ? (route, { method, body }) => console.log(method, route, body ? JSON.stringify(body) : '') : gh;
  const status = ({ state, description }) => send(`repos/${repo}/statuses/${first.head.sha}`, {
    method: 'POST',
    body: { state, description, context: CONTEXT, target_url: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` },
  });
  try {
    if (!isOutside(first)) return status(decide(first, []));
    const files = listFiles(repo, number);
    const comments = listComments();
    const now = getPull(repo, number);
    if (now.head.sha !== first.head.sha || now.base.ref !== first.base.ref) return console.log('The pull request moved; the run for its new state decides.');
    const flagged = filesToReview(files, now.changed_files);
    const labelled = now.labels.some((label) => label.name === LABEL);
    if (flagged.length && !labelled) send(`${issue}/labels`, { method: 'POST', body: { labels: [LABEL] } });
    if (!flagged.length && labelled) send(`${issue}/labels/${LABEL}`, { method: 'DELETE' });
    const body = commentBody(flagged);
    const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
    if (mine && mine.body !== body) send(`repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
    if (!mine && flagged.length) send(`${issue}/comments`, { method: 'POST', body: { body } });
    const verdict = decide(first, flagged, approvals(withEvent(comments, event)));
    status(verdict);
    // Runs can finish out of order, so check a pass from an approval against a fresh read, without the
    // event's copy (it may be older by now). Only the list's own lag can still slip through.
    if (verdict.approved && !approvals(listComments()).has(first.head.sha)) status(decide(first, flagged));
  } catch (error) {
    console.error(error);
    status({ state: 'failure', description: 'The check could not finish; re-run it' });
    process.exit(1);
  }
}

function report(number) {
  const repo = process.env.GITHUB_REPOSITORY || `${OWNER}/agent-orrery`;
  const pr = getPull(repo, number);
  const flagged = filesToReview(listFiles(repo, number), pr.changed_files);
  console.log(`#${number} by ${pr.user.login}${fromFork(pr) ? ' from a fork' : ''} at ${pr.head.sha}: ${isOutside(pr) ? 'OUTSIDE' : 'not outside'}`);
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
