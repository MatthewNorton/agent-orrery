# Contributing to Agent Orrery

Thanks for helping. This is a personal project maintained in spare time, so replies can take a while.

## Before you start

- **Bugs, and changes bigger than a small fix:** open an issue first, so we agree on the change before you build it.
- **Security problems:** report them privately as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Set up and check

Setup is in the [README](README.md#getting-started). Before you open a pull request, work through the Verification list in the [pull request template](.github/pull_request_template.md). CI runs the tests and the quick gates again, but the renderer gates launch Electron and only run on your machine.

## Rules

[AGENTS.md](AGENTS.md) holds the rules for this codebase, for people and coding agents alike. Read its *Hard constraints* first. The ones contributors hit most:

- No new dependencies or npm scripts without asking first.
- The renderer is plain JavaScript in classic `<script>` tags, with no ES modules, no bundler and no network requests.
- Fixtures use invented users and paths. `npm test` fails on a real home folder, a personal email address or a credential.

## Pull requests

- Keep each pull request to one topic, fill in the template, and add screenshots for anything visual.
- CI on an outside pull request runs once the maintainer approves it.
- Changes to agent instructions, or to code that runs during install, tests, gates or CI (`scripts/outside-pr.mjs` lists them), get a closer review, so say why they're needed. On an outside pull request, the `tooling review` check stays red until the maintainer has reviewed them.
- AI-assisted contributions are welcome. You're responsible for what you submit, so say what you ran and what you checked.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
