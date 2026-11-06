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

## The README video

A README plays video only from GitHub's upload links
(`https://github.com/user-attachments/assets/…`), not from a file in the repository or a
release asset. There is no API for these links: step 6 needs a person signed in at
github.com, so an agent stops there and hands over. To replace the video:

1. Run the app on the synthetic universe:

   ```sh
   node scripts/demo-shots.mjs --keep
   ```

   The script keeps the profile and prints the PowerShell line that starts `npm start`
   against it. On macOS use `HOME=<profile> npm start`. It also rewrites
   `docs/screenshots/`; run `git checkout -- docs/screenshots` unless you meant to update
   them.
2. Record with Win+Alt+R (Windows Game Bar), OBS, or the macOS screen recorder.
3. Check every frame for real names (see the rules below). Once the take is good, delete
   the folder the script printed after `demo profile:`.
4. Encode to 720p H.264 under 10 MB, GitHub's video limit on free plans (`demo.mp4` is
   your recording). If the file is over, raise `-crf`: each +6 roughly halves the size.

   ```sh
   ffmpeg -i demo.mp4 -vf scale=-2:720 -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart readme.mp4
   ```

5. Open a draft pull request that replaces the video link in `README.md` with
   `<!-- demo video -->`.
6. Drag `readme.mp4` into a comment on that pull request and post it.
7. Replace `<!-- demo video -->` with the link GitHub inserted, alone on its line with a
   blank line above and below. Push, and mark the pull request ready.
8. Leave the comment in place: it holds the video. Leave the old video's comment too,
   because older revisions of the README still link to it.

For a GIF instead of a video:

```sh
ffmpeg -i demo.mp4 -vf "fps=12,scale=1200:-1:flags=lanczos" -loop 0 docs/screenshots/demo.gif
```

## Rules for anything published

- Never capture the app against your real profile for anything that leaves your machine.
- Check every frame for real names before committing or uploading: project names, folder
  paths in the event feed, GitHub identities in the project card.
- The three mockup PNGs in the repository root are the kit rubric's gold samples, not
  screenshots; leave them where they are.
