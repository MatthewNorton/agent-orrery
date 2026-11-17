# Contract — Local model ships: a model loaded in a local server is a tracked ship (kit 17, Ollama adapter)

The universe legend says "Local model" and every `Ship` carries `local`, but today a local model is
tracked only when a Claude Code or Codex session happens to be served by one. A model loaded and
chatting in Ollama itself, through the Ollama desktop app, a script or an editor plugin, is
invisible. Owner, 2026-11-04: "it literally says local model tracking so when a local model is
being used it should track." Owner, 2026-11-06: the source "could be anything like LM Studio too".
So this kit adds a server-agnostic `local` provider and its first adapter: a passive main-process
poll of the local Ollama server, so a loaded model appears as a red ship with its model name,
whatever client is driving it. A second server (LM Studio, llama.cpp, vLLM) later is one more
main-process adapter and nothing else.

## Evidence (owner's machine, 2026-11-04 and 2026-11-06)

- Ollama 0.21.0 served on `127.0.0.1:11434`. `ollama ps` listed `qwen3.6:27b-q4_K_M`, 23 GB,
  100% CPU, "4 minutes from now". The only client connected to that port was the Ollama desktop
  app's own chat window. No Claude Code or Codex process was involved, so no transcript existed.
- All 70 Codex rollouts on disk say `model_provider: "openai"`; every Claude transcript of the
  last three days names a Claude model. The existing `local` paths have never fired here.
- Only Ollama is installed: `~/.ollama` exists; no LM Studio, Jan, KoboldCpp or GPT4All home.
- Ollama's file footprint is useless as a Signal watch: the app polls `/api/tags` every 30 s and
  rewrites `server.log` each time (a Signal ship would be lit forever), and chats live in a
  SQLite database the app must never read.
- No OS-level signal names a model: processes, ports and VRAM are visible, model names and
  requests in flight are not. Every usable signal is the server's own API. All local servers list
  their models on the OpenAI-style `GET /v1/models`; only the "in use" signal differs per server
  (Ollama `expires_at`, LM Studio `state: "loaded"` on `/api/v0/models`, llama.cpp `/slots`).
- `GET /api/ps` with nothing loaded returns `{"models":[]}`. With a model loaded it returns, per
  the Ollama API reference (recorded live by O0 into `.shots/ollama/killswitch.json`):

```json
{"models":[{"name":"qwen3.6:27b-q4_K_M","model":"qwen3.6:27b-q4_K_M","size":24700000000,
  "digest":"a50eda8ed977…","details":{"parent_model":"","format":"gguf","family":"qwen3",
  "families":["qwen3"],"parameter_size":"27B","quantization_level":"Q4_K_M"},
  "expires_at":"2026-11-04T03:45:12.1234567-08:00","size_vram":0,"context_length":16384}]}
```

`expires_at` is reset to now + keep-alive (default 5 min) by every request the model serves, so
an advance of `expires_at` between two polls means "a request was just served".

## Decisions (committed; a one-word veto from the owner reopens only that decision)

- **D1 Poll `GET /api/ps` on the loopback Ollama server.** It names the model, its memory split
  and `expires_at`, is identical on Windows, macOS and Linux, and carries no chat content. The
  log and database alternatives are platform-specific, always-busy or private.
- **D2 `local` is the fourth provider key, server-agnostic** (re-cut 2026-11-06; it was `ollama`).
  Main `PROVIDERS`, the public `Provider` type and the renderer's `providerKey`/`PROVIDERS` learn
  `local`, label `Local`, colour `#ff3344` (the legend's "Local model" entry, which does not
  change). A local ship is a hull, never a Signal marker, always `local: true` with `model` set.
  It is **named for its server** with the server's own counter (`Ollama-1`, `Ollama-2`…) and lives
  in the server's system. The fleet row says LOCAL, the model tag is the bare model name (the
  provider already says "local"), focus telemetry reads "Local · <model>". `ollama` is **not** a
  provider key: `normalizeProvider('ollama')` stays `generic`. *Why:* the owner wants the same
  for LM Studio and friends; one `local` provider means a second server is a main-process adapter
  with its own label and home folder, and the renderer, harness and types never change again.
- **D3 Each adapter owns one system: its home folder.** Ollama's is `~/.ollama` by default,
  shown as `Ollama`, project id `project:ollama`. *Why:* a system needs a real directory
  (existence, galaxy, planets); every Ollama install has `~/.ollama`; it lands in the Home galaxy.
  Its basename is `.ollama`, so the source re-asserts the display name after any restore.
- **D4 Semantics.** Present in `/api/ps` → ship. `expires_at` advanced → activity and `lastEvent`.
  Gone from `/api/ps` → departs ("unloaded"). Idle → the standard five-minute sweep departs it, and
  it does not re-dock until `expires_at` advances again (no flapping). Server gone → every Ollama
  ship departs, one "offline" feed line; back → one "online" line.
- **D5 Loopback only, read-only, opt-in by the caller.** Default `http://127.0.0.1:11434`;
  `providers.json` may set `"ollama": false` or `{ "host", "home" }` (the config key is per
  adapter); `OLLAMA_HOST` is honoured when it is loopback. A non-loopback or non-http host is
  refused with one warning. The source runs only when the Tracker is given `options.ollama`;
  `app-context.js` passes it for the real app, tests and fixtures that do not pass it never
  contact a socket.
- **D6 Proof.** The provider fixture injects a fake `fetch` (Electron renders the hull); the Node
  gate proves the real socket path against a throwaway `http.createServer`.

## Committed architecture (do not re-decide)

1. **`src/main/live/ollama-source.js`** (new, `// @ts-check`, ≤ 300 lines, 400 at most; a pure
   `src/main/live/ollama-host.js` may hold the endpoint parsing if space needs it). Exports:
   - `ollamaEndpoint({ config, option, env })` → `{ origin }` | `{ disabled: true }` | `{ warning }`.
     Pure. `config` is the `providers.json` value (`undefined`, `false` or `{ host, home }`),
     `option` the Tracker option host, `env` `OLLAMA_HOST`. Precedence: `config === false` →
     disabled; else host = `config.host ?? option ?? env ?? '127.0.0.1:11434'`. Accepted syntax,
     Ollama's own: `host`, `host:port`, `http://host[:port]`, optional trailing `/`. The host
     must be `127.0.0.1`, `localhost`, `::1`, `[::1]` or `0.0.0.0`; `localhost` and `0.0.0.0`
     become `127.0.0.1`, `::1` becomes `[::1]`. Default port 11434; port 1–65535. Anything else
     (another host, `https`, a path, query, userinfo, a bad port) → `{ warning }` with a one-line
     message. `// Security` at the check: this is the only place a non-loopback request could begin.
   - `parseOllamaStatus(text)` → `{ models: [{ name, size, sizeVram, expiresAt }] }` or `null`.
     `null` for non-JSON, no `models` array, or text over 256 KiB. `name` is `modelName(entry.name
     ?? entry.model)` from `src/main/transcripts/model.js` (control characters dropped, 64 chars);
     entries without a name are skipped; duplicates keep the first; at most 32 models. `size` and
     `sizeVram` (from `size_vram`) are finite numbers ≥ 0 else 0; `expiresAt` is
     `Date.parse(expires_at)` else 0. No other field is read.
   - `ollamaDetail(size, sizeVram)` → `null` when `size <= 0`; else `"<GB> · <processor>"` with
     `<GB>` = `(size / 1e9).toFixed(1) + ' GB'` and `<processor>` = `100% CPU` when `sizeVram <= 0`,
     `100% GPU` when `sizeVram >= size`, else `"<cpu>%/<gpu>% CPU/GPU"` with
     `cpu = Math.round((size - sizeVram) / size * 100)`, `gpu = 100 - cpu`. Example:
     `ollamaDetail(10e9, 6e9) === '10.0 GB · 40%/60% CPU/GPU'`.
   - `applyOllamaStatus(model, status, now)` — the reducer, below. Never calls `Date.now()`.
   - `pollOllama(model)` → `Promise<{ polled: boolean, reachable: boolean | null }>`, below.
   - `stopOllama(model)` aborts an in-flight request.
2. **State on the model, no module-level state.** `createLiveModel` sets `model.ollama` from
   `options.ollama`: `null` when the option is absent (source off), else

   ```js
   { host: string | null,          // options.ollama.host
     home: string,                 // options.ollama.home ?? path.join(os.homedir(), '.ollama')
     fetch: Function,              // options.ollama.fetch ?? globalThis.fetch
     inFlight: AbortController | null,
     failures: number,             // consecutive failed polls, 0 after a success
     nextPollAt: number,           // ms epoch; a poll before it is skipped (backoff); 0 after a success
     reachable: boolean | null,    // null until the first verdict
     loaded: Map<string, { expiresAt: number, shipId: string }> }   // by model name
   ```

   `LiveModelOptions.ollama?: { host?: string, home?: string, fetch?: Function }` and
   `LiveModel.ollama` go into `src/types/live-model.d.ts`.
3. **The reducer.** `status` is `{ reachable: true, models }` (parsed) or `{ reachable: false }`.
   - `reachable: false`: every ship in `loaded` departs (`ship-departed` + feed `depart`
     "`<ship.name>` unloaded"), `loaded` is cleared, and when `reachable` was `true` one feed
     `info` line "Ollama server offline" is pushed. `reachable` becomes `false`. A second
     `reachable: false` queues nothing.
   - `reachable: true`: when `reachable` was `false`, feed `info` "Ollama server online" (`null` →
     `true` is silent). When `models` is non-empty, ensure the project with
     `ensureProjectForPath(model, home, 'project:ollama', now, 0)`; when its `name` is not
     `Ollama`, set it and `announceProjectUpdated`. When `home` is not a directory, warn once
     through `model.providerWarnings` ("Ollama home folder <home> not found; set ollama.home in
     providers.json") and continue (the system renders as derelict until the folder exists). Then
     for each parsed model, with `sessionId = 'ollama-' + hex8(name)` and
     `shipId = 'ship:local:' + sessionId`:
     - no record in `loaded` → spawn: `ensureProviderShip(model, 'local', project.id, sessionId,
       'main', now, null, { local: true, model: name, label: 'Ollama' })`, `status = 'Working'`,
       `detail = ollamaDetail(...)`, record `{ expiresAt, shipId }`. The `ship-spawned` event must
       already say `provider: 'local'`, `name: 'Ollama-<n>'`, `local: true` and carry `model`.
     - record exists and `model.ships` lacks `shipId` (the idle sweep departed it): re-spawn only
       when `expiresAt > record.expiresAt`; otherwise nothing.
     - record exists and the ship exists: when `expiresAt > record.expiresAt`, set
       `ship.lastEvent = now`, refresh `detail`, queue `ship-updated` and
       `{ type: 'activity', project, shipId, tool: 'ollama', status: 'Working', detail, ts: now }`;
       when only `detail` changed, queue `ship-updated` alone; otherwise nothing. Update the record.
     - every recorded model absent from `models` departs as in the offline case, record deleted.
   - The reducer never sets `attention`, never counts builds, never reads a field the parser did
     not produce, and `liveShip(ship)` keeps exactly the public keys it has today (no `runtime`
     field: the name and the system already say which server).
4. **`pollOllama(model)`.** `model.ollama` null → `{ polled: false, reachable: null }`. Read
   `readGenericWatchConfig(model.providerConfigPath).ollama` and resolve `ollamaEndpoint({ config,
   option: model.ollama.host, env: process.env.OLLAMA_HOST })`. Disabled or warning (warned once
   via `model.providerWarnings`, `console.warn('[providers] …')`): when `loaded` is non-empty apply
   `{ reachable: false }` so no ship lingers, then return `polled: false`. In flight or
   `now < nextPollAt` → `polled: false`. Otherwise one `GET <origin>/api/ps` through `model.ollama.
   fetch(url, { signal })`, no headers, no body, 3 s `AbortController` timeout, `inFlight` set for
   the duration. A 2xx whose `text()` parses → `failures = 0`, `nextPollAt = 0`, reducer
   `{ reachable: true, models }`. Anything else (network error, non-2xx, timeout, oversize or
   invalid body) → `failures += 1`, `nextPollAt = now + (15 s, 30 s, then 60 s)`, and from the
   second consecutive failure on, reducer `{ reachable: false }`. Always `flush(model)` after a
   reducer call, always clear `inFlight`, never throw, never retry inside one call.
5. **Tracker.** `start()` polls once at once and every `OLLAMA_POLL_MS = 5000` when `model.ollama`
   is set (the timer joins `this.timers`); `stop()` calls `stopOllama` before saving; a public
   single step `pollOllama()` returns the source's promise. The first poll is asynchronous, so a
   `snapshot()` taken synchronously after `start()` has no local ship — `kit/done/multi-provider/
   grade-providers.mjs` relies on that.
6. **Wiring.** `app-context.js` passes `{ ollama: {} }` for the real app (both constructor
   branches that are not fixtures). `createProviderFixture` adds `options.ollama = { home, fetch }`
   with `home` a created folder under the fixture root and `fetch` resolving
   `{ ok: true, status: 200, text: async () => JSON.stringify(payload) }` where `payload` holds one
   model `fixture-local:7b`, `size` 4e9, `size_vram` 0, `expires_at` four minutes ahead.
7. **Config.** `readGenericWatchConfig` also returns `ollama`: `undefined` when the key is absent,
   `false` when `false`, `{ host: string | null, home: string | null }` for a plain object (`host`
   trimmed to 128 chars; `home` through `safePath` and the absolute-syntax check, else `null`), and
   a warning "provider config ollama entry must be false or an object" otherwise. A file with
   `ollama` but no `watch` is valid: `watch` becomes optional (missing → `[]`); the existing warning
   stays for a present non-array `watch`.
8. **Provider plumbing.** `PROVIDERS` in `provider-adapters.js` gains `'local'`; `Provider` in
   `src/types/contract.d.ts` gains `'local'`. `ensureProviderShip` gains an optional trailing
   `facts` argument `{ local?: boolean, model?: string, label?: string }`: `label` names the ship
   family, so the name is `<label>-<n>` with `n` counted on `model.providerCounters` under the key
   `<provider>:<label>`; `local` and `model` go to `createShipRecord` so the `ship-spawned` event
   carries them. Without `facts` the name, counter and record are exactly today's (the other
   callers pass nothing). History and replay are untouched: local ships exist in LIVE only, like
   `vcs`. The terminal and focus actions already refuse any provider other than Claude and Codex on
   the main side, so a local ship gets the same graceful failure a Signal ship gets; no renderer
   gating changes.
9. **Renderer**, three small edits and nothing else:
   - `src/renderer/util.js`: `PROVIDERS.local = { key: 'local', label: 'Local', color: '#ff3344' }`
     (the same colour as `AUR.LOCAL_MODEL`, which stays); `providerKey` maps `local` to `'local'`
     before the generic fallback; `modelLabel` omits the `Local` prefix when
     `providerKey(ship.provider) === 'local'` (the row's LOCAL tag and focus's provider label
     already say it), so an Ollama ship's tag is the bare model name while a local Codex session
     keeps "Local · <model>". `isSignalEntity` stays `generic`-only (a hull); `shipColor` is already
     red for `local: true`.
   - `src/renderer/util-scene.js`: `sceneProviderStats` starts its counts from every key of
     `AUR.PROVIDERS` instead of the literal `{ claude: 0, codex: 0, generic: 0 }`, which would make
     `providerCounts.local` `NaN`.
   - `src/renderer/ship-assets.js` `selectHull`: a non-generic provider key absent from
     `manifest.providerFamilies` (the frozen manifest lists `claude` and `codex` only) flies the
     first listed family — today every provider flies `aur-fleet-v3` — so a local ship gets a real
     hull in red livery. `assets/ships/manifest.json` stays frozen.
   The legend in `index.html` is static and already right (Claude, Codex, Local model, Needs you).
10. **Harness** (`src/main/harness/modes/provider.js`): the wait loop also waits for a visual with
    `providerKey === 'local'` and an `assetHullId`; the DOM probe adds `modelTags` (text of every
    `.agent-model-tag`); all count objects gain `local`; `result.providerMetrics.modelTags` is
    written; `passed` additionally requires `local` ≥ 1 in public, mesh and row counts, a hull
    (not `signal-marker`) for it, the sidebar tag `LOCAL`, `modelTags` containing
    `fixture-local:7b`, and `distinctProviderColors >= 4`.

## Editable scope

- `src/main/live/ollama-source.js` (new), optionally `src/main/live/ollama-host.js` (new)
- `src/main/live/model.js`, `src/main/live/ships.js` (the `facts` argument), `src/main/tracker.js`,
  `src/main/app-context.js`, `src/main/provider-adapters.js`
- `src/main/harness/fixtures.js`, `src/main/harness/modes/provider.js`
- `src/types/contract.d.ts`, `src/types/live-model.d.ts`
- `src/renderer/util.js`, `src/renderer/util-scene.js`, `src/renderer/ship-assets.js` (only the
  edits named in architecture item 9)
- `test/live-ollama-source.test.js` (new), `test/live-ships.test.js`, a renderer util test if one
  is added (`test/renderer-util.test.js`, loading `util.js` in a `vm` sandbox as
  `test/shared-hash.test.js` does)
- `kit/SPEC.md` §3, `docs/MULTI-PROVIDER.md`, `README.md`, `SECURITY.md`, `AGENTS.md`,
  `.docs/architecture.md`, `kit/README.md` ("How the app works")

Everything else is frozen, in particular `package.json`, the lockfile, `assets/**`, the mockup
PNGs, `src/preload.js`, `src/main/window.js`, `src/main/window-security.js`, every renderer file
other than the three named, `kit/grade.mjs`, `kit/done/**`, and this kit's `grade-ollama.mjs`. Add
no dependency; the renderer makes no network request; the main process makes exactly the loopback
`GET` described here and nothing else.

## O0 — kill-switch (runner, with the owner, before feeding the executor)

```powershell
node kit/todo/17-ollama-source/grade-ollama.mjs --killswitch
```

It polls `/api/ps` on `OLLAMA_HOST` or `127.0.0.1:11434` every 2 s for 90 s, prints every change
of a model's `expires_at`, and writes the last non-empty payload to `.shots/ollama/killswitch.json`
(the executor's reference shape). During the window the owner sends two messages in the Ollama app,
or the runner runs `ollama run gemma4:e4b "say hi"` twice (a small model; ask first, the owner may
be using the server). PASS when one model's `expires_at` advanced at least twice. Not advancing
means `OLLAMA_KEEP_ALIVE` is infinite or the API changed: write `kit/BLOCKED.md` with the output
and stop. Do not invent another signal.

## Mechanical checks (`grade-ollama.mjs`)

- **O1 layout.** `src/main/live/ollama-source.js` exists, first line `// @ts-check`, ≤ 400 lines,
  no top-level `let`, exports the six functions above; `Tracker.prototype.pollOllama` is a
  function; `live/model.js` mentions `ollama`.
- **O2 endpoint table** (pure, exact):

  | config | option | env | result |
  |---|---|---|---|
  | — | — | — | `http://127.0.0.1:11434` |
  | — | — | `0.0.0.0:11434` | `http://127.0.0.1:11434` |
  | — | — | `http://localhost:11435/` | `http://127.0.0.1:11435` |
  | — | — | `127.0.0.1` | `http://127.0.0.1:11434` |
  | — | — | `[::1]:11434` | `http://[::1]:11434` |
  | `{ host: '127.0.0.1:11500' }` | `127.0.0.1:11600` | `0.0.0.0:11434` | `http://127.0.0.1:11500` |
  | — | `127.0.0.1:11600` | `0.0.0.0:11434` | `http://127.0.0.1:11600` |
  | `false` | any | any | `{ disabled: true }` |
  | — | — | `192.168.1.20:11434` | warning |
  | — | — | `https://127.0.0.1:11434` | warning |
  | — | — | `http://127.0.0.1:11434/api` | warning |
  | — | — | `http://user@127.0.0.1:11434` | warning |
  | — | — | `127.0.0.1:99999` | warning |
  | — | — | `ollama.example.com` | warning |

- **O3 reducer fixtures** on a real `createLiveModel` with temp folders, a fixed clock `T0`, a
  `fetch` that rejects (the reducer must not need it), events collected through `publish` after
  `flush`:
  1. `qwen3.6:27b-q4_K_M` (size 23e9, vram 0, expires T0+5 min) at T0 → `project-added` with
     `name: 'Ollama'`, `path` = home, `id: 'project:ollama'`; `ship-spawned` with `provider:
     'local'`, `name: 'Ollama-1'`, `id` matching `^ship:local:ollama-[0-9a-f]{8}$`, `kind: 'main'`,
     `local: true`, `model: 'qwen3.6:27b-q4_K_M'`, `status: 'Working'`, `detail: '23.0 GB · 100%
     CPU'`, `attention: null`, `builds: 0`, `lastEvent: T0`; feed `spawn` "Ollama-1 entered
     Ollama". The public ship's keys are exactly today's `liveShip` keys.
  2. The same status at T0+5 s → no events.
  3. `expires_at` advanced at T0+10 s → `ship-updated` (`lastEvent` T0+10 s) and `activity`
     (`tool: 'ollama'`, `status: 'Working'`, that `shipId`, `ts` T0+10 s). Nothing else.
  4. A second model `gemma4:e4b` (size 4e9, vram 4e9) joins at T0+15 s → `Ollama-2`, detail
     `'4.0 GB · 100% GPU'`; `ollamaDetail(10e9, 6e9) === '10.0 GB · 40%/60% CPU/GPU'`.
  5. The first model gone at T0+20 s → `ship-departed` for Ollama-1, feed `depart`
     "Ollama-1 unloaded"; Ollama-2 untouched.
  6. `{ reachable: false }` at T0+25 s → Ollama-2 departs, feed `info` "Ollama server offline";
     another `{ reachable: false }` → no events.
  7. Reachable again with `gemma4:e4b` at T0+30 s → feed `info` "Ollama server online" then
     `ship-spawned` `Ollama-3`.
  8. Anti-flap: `departIdleShips(model, T0+30 s + 6 min)` departs Ollama-3; the same `expires_at`
     at T0+30 s + 6 min + 5 s → no spawn; an advanced `expires_at` 5 s later → `ship-spawned`
     `Ollama-4`.
  9. Sanitising: an entry with `name` of 100 letters plus a `\u0007` → `model` is 64 characters
     without control characters; an entry with no `name` and no `model` is skipped; 40 entries →
     at most 32 ships; a `models` value that is not an array → `parseOllamaStatus` returns `null`.
  10. Untouched callers: `ensureProviderShip(model, 'codex', <project>, 'sess-1', 'main', T0, null)`
     with no `facts` still spawns `Codex-1` with `local: false`, `model: null`.
- **O4 real sockets through the Tracker** against a throwaway `http.createServer` on
  `127.0.0.1:0` that serves a mutable `/api/ps` payload, counts hits and records method and path,
  with empty temp Claude and Codex folders and `ollama: { host: '127.0.0.1:<port>', home }`; "a
  local ship" below means a snapshot ship with `provider === 'local'`:
  1. `await tracker.pollOllama()` → `{ polled: true, reachable: true }`; one local ship in the
     snapshot; the server saw exactly one request, `GET /api/ps`, and no other path.
  2. Empty `models` → next poll departs the ship.
  3. `saveState()`, a new Tracker on the same state path and options, `await pollOllama()` with a
     model loaded → the project is still `project:ollama` named `Ollama`.
  4. Server closed: first poll → `reachable` still as before, `failures === 1`, `nextPollAt > now`;
     an immediate second call → `polled: false`; with `nextPollAt = 0`, the second real failure →
     `reachable: false`, no ship, no throw.
  5. `providers.json` with `{ "ollama": { "host": "10.0.0.5:11434" } }` → a poll makes no request,
     exactly one `[providers]` warning; with `{ "ollama": false }` → no request, no warning.
  6. A 300 KiB body → counted as a failure, no ship.
  7. A server that never answers → `pollOllama()` settles within 4 s with `failures === 1`.
  8. A poll in flight against that server, then `tracker.stop()` → the poll settles within 500 ms.
  9. A Tracker built **without** `options.ollama`, `start()`, 300 ms, `stop()` → the server saw
     zero requests and `tracker.pollOllama()` resolves `{ polled: false, reachable: null }`.
- **O5 provider key behaviour.** Main: `normalizeProvider('local') === 'local'`,
  `normalizeProvider(' Local ') === 'local'`, `normalizeProvider('ollama') === 'generic'`;
  `contract.d.ts` has `'local'` in `Provider`. Renderer, with `util.js` then `util-scene.js` run in
  a `vm` sandbox `{ window: {}, BABYLON: {} }` exactly as `test/shared-hash.test.js` loads `util.js`:
  `providerKey('local') === 'local'`, `providerKey(' Local ') === 'local'`, `providerMeta('local')`
  deep-equals `{ key: 'local', label: 'Local', color: '#ff3344' }`, `PROVIDERS.local.color ===
  LOCAL_MODEL.color`, `isSignalEntity({ provider: 'local', local: true }) === false`,
  `shipColor({ provider: 'local', local: true }) === '#ff3344'`, `modelLabel({ provider: 'local',
  local: true, model: 'qwen3.6:27b' }) === 'qwen3.6:27b'`, `modelLabel({ provider: 'codex', local:
  true, model: 'x' }) === 'Local · x'`, `modelLabel({ provider: 'local', local: true, model: null })
  === ''`; `sceneProviderStats` over a fake scene with one `claude` and one `local` ship mesh
  (metadata `isShip`, `providerKey`, `shipId`, `providerTint: '#ff3344'`, material emissive
  `#FF3344`) returns `providerCounts` `{ claude: 1, codex: 0, generic: 0, local: 1 }`, no `NaN`.
- **O6 rendered proof.** `electron . --provider-test --provider-output=<dir>` exits 0;
  `result.json` has `passed: true`, `publicProviderCounts.local ≥ 1`, `meshProviderCounts.local
  ≥ 1`, `rowProviderCounts.local ≥ 1`, a visual with `providerKey 'local'`, a truthy
  `assetHullId` and `visualKind !== 'signal-marker'`, `sidebarProviderTags` containing `LOCAL`,
  `modelTags` containing `fixture-local:7b`, `distinctProviderColors ≥ 4`, no renderer errors;
  `universe.png` is fresh and over 30 KB.
- **O7 docs.** `kit/SPEC.md` names `'local'` in the `Ship.provider` line and `/api/ps` in the
  `local` comment; `docs/MULTI-PROVIDER.md` has a `## Local model servers` section naming Ollama,
  `/api/ps`, `"ollama": false`, `OLLAMA_HOST`, loopback, that chats are never read, and LM Studio
  as the shape of the next adapter; `SECURITY.md`'s scope names Ollama and loopback; `README.md`
  names Ollama; `AGENTS.md` names `ollama-source` and the `local` provider.
- **O8 regression.** `node kit/grade.mjs` and `npm run typecheck` exit 0.

Flags: `--fixtures-only` runs O1–O5 and O7; `--no-regression` skips O8; `--killswitch` runs O0
alone. Baseline today: O1 fails ("not implemented yet") and the script exits 1 without launching
Electron.

## Human spot checks (runner, after the gates pass)

- **S1** `npm start` with Ollama running; send one message in the Ollama app. Within 10 s a red
  `Ollama-1` appears in the `Ollama` system (Home galaxy) with the model name as its tag, the fleet
  row says LOCAL, and focus mode's telemetry reads "Local · <model>".
- **S2** Stop chatting. The ship warps out about five minutes after the last message, not before.
- **S3** Quit Ollama: the ship departs within 15 s and the feed says "Ollama server offline"; start
  it and load a model: "Ollama server online" and a new ship.
- **S4** Replay mode shows no local ship; returning to LIVE shows it again.
- **S5** `"ollama": false` in `providers.json`, restart: no Ollama activity, no warning.
- **S6** `OLLAMA_HOST=192.168.1.20:11434`, restart: one `[providers]` warning, no request.
- **S7** A local Codex session (if one is handy) still shows CODEX in the row with "Local · <model>".

## Out of scope (each an owner call later)

- The next adapters, each a sibling `src/main/live/<server>-source.js` plus a `providers.json`
  key, same `local` provider, own label and home-folder system, no renderer change: LM Studio
  (`GET /api/v0/models` on `127.0.0.1:1234`, `state: "loaded"`, home `~/.lmstudio`; its idle TTL
  resets per request but is not listed, so "busy" would come from `lms log stream`), llama.cpp
  (`/slots` `is_processing`, port 8080), vLLM (`/metrics`, port 8000).
- A public `runtime` field on `Ship`: nothing in the renderer reads it yet; the name and system
  carry the server. Add it with the first surface that needs it.
- Reading chat history, token counts or per-request timing from Ollama.
- Attributing an Ollama request to the client's project (Ollama does not know the client).
- Remote Ollama hosts: the `// Security` check in `ollamaEndpoint` is where that would be relaxed.
- Local-server activity in history playback.

## Gates

```powershell
node kit/todo/17-ollama-source/grade-ollama.mjs --fixtures-only   # quick loop, no Electron
node kit/todo/17-ollama-source/grade-ollama.mjs                    # full: O1–O8
node kit/grade.mjs
node kit/run-gates.mjs                                              # every done gate and npm test
npm run typecheck
```

## Execution

- **Feeding.** The prompt in `kit/EXECUTOR-HANDOFF.md` with `<KIT_CONTRACT_PATH>` =
  `kit/todo/17-ollama-source/CONTRACT.md`.
- **Executor.** Claude Opus 5.5 at high effort throughout (kit-runner, the executor session and
  every subagent), the owner's standing rule. Fallback: no model switch; a stalled run gets a fresh
  Opus 5.5 session with only the failing check IDs and grader output; Opus unavailable →
  `kit/BLOCKED.md`.
- **PR.** One PR. Before it is reported ready: the full gate sweep green and a `/simplify` pass.
  On pass the runner moves `grade-ollama.mjs` to `kit/done/ollama-source/`, adds the row to
  `kit/run-gates.mjs`, and updates `kit/README.md`, `kit/todo/README.md` and
  `kit/EXECUTOR-HANDOFF.md`.

## Pre-answered objections

- **"Why not an `ollama` provider key?"** That was the first cut (2026-11-04). The owner's
  2026-11-06 question — "it could be anything like LM Studio too" — showed the renderer, harness
  and types would otherwise grow one entry per server. `local` is what the legend already says and
  what every such ship has in common; the server lives in the name and the system.
- **"Then LM Studio ships and Ollama ships look identical."** Both are red hulls with a LOCAL
  tag, which is the legend's promise. They differ by name (`Ollama-1`, `LM Studio-1`) and by
  system. A `runtime` field is one line in `liveShip` the day a surface wants more.
- **"Watch Ollama's log folder as a Signal instead."** The app heartbeats `/api/tags` every 30 s,
  so the log is always fresh and the ship always lit; the log names no model; the path differs per
  OS. `/api/ps` answers all three.
- **"Poll `/v1/models` so every server works today."** It lists downloaded or offered models, not
  loaded or busy ones; every ship would be lit forever. The in-use signal is per server, so the
  adapters are per server while the provider is shared.
- **"The app only reads files; this adds network."** The renderer stays offline. The main process
  already runs bounded `gh` processes for GitHub metadata; this adds one loopback status `GET`,
  opt-in by the caller, refusable in `providers.json`, with the check documented in `SECURITY.md`.
- **"Why a provider, not a red Signal ship?"** Signal draws as a marker, not a hull, and its row
  says SIGNAL. The owner asked for a ship. The red livery exists already; the provider key is a
  few lines in `util.js` plus the main-side set.
- **"A model can sit loaded for hours."** Idle departure after five minutes is the universal rule,
  and the ship returns on the next served request because `expires_at` advances. With an infinite
  keep-alive Ollama reports no per-request change, so the ship shows once per load; documented.
- **"Polling cost."** One ~1 KB loopback `GET` per 5 s while up, one per 60 s while down; `ollama
  ps` itself makes the same call.
- **"Ollama's API may change."** The parser reads four fields with defaults; an unknown shape gives
  no ships and one warning, never an exception. O0 records the live shape before anything is built.
