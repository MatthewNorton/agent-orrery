# Demo media without leaking your universe

The app visualizes whatever is in your local Claude Code and Codex transcripts, so a
screenshot or recording of your real universe shows your real project names, folder
structure, and what your agents were doing. Every image and clip published from this
repository is made from a **synthetic universe** instead.

## Screenshots

```sh
node scripts/demo-shots.mjs
```

The script:

1. creates a throwaway home directory in the system temp folder;
2. fills it with fictional projects (`orion-api`, `quasar-notes`, `vega-charts`, …) in
   three galaxies, finished sessions from days ago, a persisted state file with
   made-up edit counts so planets have mass, and a few live sessions (three Claude,
   one Codex, one subagent drone, one pending permission prompt);
3. launches the app with `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` pointed
   at that directory, exactly as the kit gates do, so neither your transcripts nor the
   real `universe-state.json` are read;
4. runs the app's built-in `--shots` mode, which captures the universe, a solar system,
   and a planet, and copies them to `docs/screenshots/`;
5. deletes the throwaway directory.

The universe is deterministic (seeded), so re-running produces the same layout apart
from orbital positions. Edit the `GALAXIES` table in `scripts/lib/synthetic-profile.mjs`
to change the fictional projects; `node kit/grade.mjs` grades the app against the same universe.

## Video or GIF

Keep the profile and run the live app against it:

```sh
node scripts/demo-shots.mjs --keep
```

The script prints the PowerShell line that starts `npm start` with the environment
pointed at the kept profile. In that window, record with Win+Alt+R (Windows Game Bar)
or OBS, fly around, then delete the printed profile folder. On macOS use
`HOME=<profile> npm start` and the built-in screen recorder.

To turn a recording into a README-sized GIF:

```sh
ffmpeg -i demo.mp4 -vf "fps=12,scale=1200:-1:flags=lanczos" -loop 0 docs/screenshots/demo.gif
```

## Rules for anything published

- Never capture the app against your real profile for anything that leaves your machine.
- Check every frame for real names before committing: project names, folder paths in
  the event feed, GitHub identities in the project card.
- The three mockup PNGs in the repository root are the kit rubric's gold samples, not
  screenshots; leave them where they are.
