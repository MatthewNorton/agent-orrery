# Contributing to Agent Orrery

Thanks for helping. This is a personal project maintained in spare time, so replies can take a while.

## Before you start

- **Bugs:** open an issue with the bug report form.
- **Anything bigger than a small fix:** open an issue first and describe the change, so we agree on it before you build it.
- **Security problems:** report them privately as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Set up and check

Requirements and setup are in the [README](README.md#getting-started). Before you open a pull request, run:

```sh
npm test                 # every test, including a check for leaked personal paths and credentials
npm run typecheck        # the JSDoc types
node kit/grade.mjs       # after any renderer change
node kit/run-gates.mjs   # every gate; takes a few minutes and needs the Electron runtime from npm install
```

## Rules

[AGENTS.md](AGENTS.md) holds the rules for this codebase. They apply to people as much as to coding agents. These are the ones contributors run into most:

- **Frozen files:** `assets/*`, the mockup PNGs, `src/preload.js` and `package.json` change only when the maintainer agrees, and that includes new dependencies and npm scripts.
- **Renderer:** plain JavaScript in classic `<script>` tags, with no ES modules, no bundler and no network requests.
- **Size:** files stay around 300 lines, 400 at most.
- **Fixtures:** invented users and paths only. `npm test` fails on a real home folder, a personal email address or a credential.

## Pull requests

- Keep each pull request to one topic, fill in the template, and add screenshots for anything visual.
- CI runs on GitHub after the maintainer approves the run, which every outside pull request needs.
- Changes to `AGENTS.md`, `CLAUDE.md`, `.github/`, `package.json`, `scripts/` or anything else that runs on a developer's machine get a closer review. Say in the description why they're needed.
- AI-assisted contributions are welcome. You're responsible for what you submit, so say what you ran and what you checked.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
