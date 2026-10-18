# Git and GitHub project status

This feature is deliberately split into local Git discovery, remote GitHub
enrichment, and renderer presentation. The isolated renderer component is the
first deliverable; it accepts data but does not inspect repositories or handle
credentials.

## Task list

- [x] Define one normalized project-status contract.
- [x] Build isolated star-field markers for GitHub and uncommitted changes.
- [x] Build an isolated project detail component for branch, worktree state,
  and open pull requests.
- [x] Add GitHub/local-only filtering that can compose with project search.
- [x] Add a standalone component lab and unit tests.
- [x] Add a bounded local Git collector in the Electron main process.
- [x] Add bounded multi-project refresh, caching, and stale-result protection.
- [x] Detect and normalize GitHub remotes from every tracked project.
- [x] Add a GitHub metadata provider with authentication and caching.
- [x] Merge cached GitHub metadata into live project status.
- [x] Expose sanitized status snapshots through preload IPC.
- [x] Add the filter and status markers to the real universe scene.
- [x] Add repository details to the real solar-system project card.
- [x] Refresh local state on focus and repository activity without polling Git
  continuously.
- [x] Add integration fixtures for clean, dirty, detached, local-only, private,
  missing, and rate-limited repositories.

## Component contract

The component lives in `src/renderer/components/project-vcs-status.js` and
publishes `window.AUR.ProjectVcsStatus` in the renderer. It is also exported as
CommonJS so its normalization and filtering behavior can be unit tested.

```js
{
  id: 'agent-orrery',
  name: 'agent-orrery',
  path: 'C:\\workspace\\agent-orrery',
  git: {
    branch: 'feat/github-project-status',
    detached: false,
    dirty: true,
    changedFiles: 4,
  },
  github: {
    url: 'https://github.com/MatthewNorton/agent-orrery.git',
    nameWithOwner: 'MatthewNorton/agent-orrery',
    openPullRequests: 2,
    state: 'ready', // ready | stale | loading | unknown | error
  },
}
```

The presentation API is intentionally small:

- `normalize(project)` returns the stable renderer model.
- `filterProjects(projects, { filter, query })` composes repository status with
  the existing search query.
- `renderMarkers(container, project)` renders non-interactive star-field
  markers. The marker host uses `pointer-events: none` so it cannot intercept
  Babylon scene picking.
- `renderDetails(container, project)` renders branch, worktree, and pull-request
  state for the solar-system project card.

Run `npm run status:lab` to inspect both component modes without changing the
main application.

The local collector lives in `src/main/vcs-status/collector.js`. Its
`createLocalGitStatusCollector().read(projectPath)` method executes two bounded,
non-shell Git commands and returns the same `git` and `github` fields consumed
by the renderer component. It resolves the project to a real directory, disables
optional locks and filesystem-monitor hooks, limits runtime and output, treats a
repository with no remotes as a valid local-only project, and returns explicit
failure codes instead of guessing clean state.

`src/main/vcs-status/service.js` coordinates the collector across a
project snapshot. It deduplicates IDs, caps the number of accepted projects,
limits concurrent Git processes, caches short-lived results, coalesces duplicate
reads, and prevents a slow result for an old project path from overwriting a
newer one. It is still independent of the tracker and renderer lifecycle; that
wiring is owned by `src/main/vcs-status/controller.js`.

The controller refreshes all current live projects at startup and on window
focus, debounces project/build events into targeted forced refreshes, enriches
live snapshots and solar-system data without mutating tracker records, and keeps
replay snapshots historical. The preload exposes sanitized change events but no
renderer-triggered refresh, Git commands, raw stderr, or credentials.

`src/main/vcs-status/github-metadata-provider.js` is the remote-only adapter. It validates
and deduplicates repository identities, batches count-only GraphQL projections,
and invokes a fixed `gh api graphql` query without a shell or interactive prompts.
The adapter bounds query count, runtime, and combined output; serializes CLI
calls; caches successful results for five minutes; briefly caches failures; and
retains the last successful count as stale when GitHub is unavailable. Raw API
errors, CLI stderr, authentication material, and tokens never enter its public
result contract.

The project status service batches every discovered GitHub remote after its
bounded local refresh, merges only matching repository identities, and keeps
local-only repositories independent of network health. Local refreshes retain
the cached remote projection so file activity does not make PR counts flicker
back to unknown. A remote outage produces an explicit error state, while a
previously successful count can remain visible as stale.

The real universe view loads the same presentation module as the isolated lab.
Its top-bar GitHub toggle composes with project search and dims unmatched star
systems without removing their pick targets. A pointer-transparent projection
layer keeps the GitHub and uncommitted-change markers anchored to their Babylon
stars as the camera moves. The all-projects directory reuses those same marker
nodes, and live preload events replace only the affected project's `vcs` value.

The solar-system project card mounts the module's repository details in a
compact three-column layout: current branch, clean/uncommitted worktree state,
and open pull-request count. Stale counts stay labeled as stale. Repository
links leave Electron through a bounded IPC handler that accepts canonical
`github.com/owner/repository` URLs only.

The integration suite creates disposable real Git repositories and exercises
the collector, multi-project service, and GitHub provider together. It covers
clean and dirty GitHub projects, detached HEAD, a named local-only branch,
private/unavailable GitHub metadata, a missing folder, and stale PR retention
after a simulated rate limit.

## Data-source decision

Do not use the GitHub API for branch or uncommitted-change state. GitHub cannot
see edits that have not left the machine, and the active local branch can differ
from the remote default branch.

Use two providers behind one main-process service:

1. **Local Git provider** — run Git directly with argument arrays, never through
   a shell. A single `git status --porcelain=v2 --branch -z` call can provide the
   branch and working-tree state. Read configured remote URLs locally and
   normalize HTTPS and SSH GitHub URLs.
2. **GitHub provider** — use GitHub GraphQL for remote-only enrichment. Batch
   repositories into a query and request
   `pullRequests(states: OPEN, first: 1) { totalCount }`. This returns the count
   without downloading every pull request and avoids one REST request per
   project.

For an initial developer build, the fixed `gh api graphql` adapter reuses the
user's existing GitHub CLI login while preventing caller-supplied operations,
pinning requests to `github.com`, and keeping responses in memory only. An
optional `AGENT_UNIVERSE_GITHUB_TOKEN` can provide a dedicated fine-grained
read-only token; ambient token and enterprise-host variables are not forwarded.
The application must not print, persist, or send authentication material to the
renderer. A distributed build should use a GitHub App installation token with
pull-request read permission while keeping the same provider interface.

Unauthenticated REST is unsuitable for a universe containing dozens of
projects: GitHub limits unauthenticated REST clients to 60 requests per hour,
while authenticated user requests generally receive 5,000 requests per hour.
GraphQL uses a separate point-based limit and is a better fit for batching this
small cross-repository projection.

Official references:

- [GitHub GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [PullRequestConnection totalCount](https://docs.github.com/en/graphql/reference/pulls#pullrequestconnection)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub CLI API command](https://cli.github.com/manual/gh_api)

## Refresh and failure behavior

- Local status: refresh when the project becomes active, the app regains focus,
  or tracked file activity is observed. Debounce bursts.
- GitHub status: cache for five minutes and refresh in the background.
- Missing GitHub auth: keep the GitHub marker because the remote is local data,
  but show pull requests as `Not fetched`.
- API failure or rate limit: retain the last successful count, mark it stale,
  and avoid retry loops.
- Missing or moved project path: report local status as unavailable; never turn
  that into a false clean state.
