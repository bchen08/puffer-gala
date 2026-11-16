# Puff Royale

A real-time category party game for up to 500 players in one room, in the browser, no install.

Everyone sees the same prompt ("Name an animal") at the same moment while a puffer inflates.
Type an answer nobody else has claimed before it pops. No accepted answer when it pops costs a
heart; rare answers earn one back. When eight players are left the game becomes hot potato:
one player holds the puffer and must answer before their own fuse runs out. Last one floating wins.

- `ARCHITECTURE.md`: design decisions, trade-offs and capacity math
- `reports/balance.md`: balance simulation behind the default settings
- `reports/loadtest-400x1.md`, `reports/loadtest-400x3.md`: load test results

## Requirements

Node.js 24 or newer (the server runs its TypeScript sources directly). Nothing else.

```bash
npm install
```

## Run locally

One command builds the client and starts the server on http://localhost:8787:

```bash
npm start
```

- Open http://localhost:8787, choose **Host a new room**, enter a name. You are the host and a player.
- Other players open `/r/CODE` (or type the code on the home page).
- Open `/r/CODE/screen` on the projector. Opened in the host's browser it also has the host controls.
- To let phones on the same network join, use your machine's LAN address instead of `localhost`.

For development with hot reload (client on http://localhost:5173, server restarting on change):

```bash
npm run dev
```

No crowd handy? Fill a room with bots that play like people. Host a room in the browser first,
then pass the four-letter code it shows (`RMHF` below is an example, not a real room):

```bash
npm run bots -- --room RMHF --players 40
```

The bots stay until you press Ctrl+C. If the room does not exist or the server is not running,
the command says so.

### Server settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `LOG_DIR` | `data/logs` | Where submission logs are written; `off` disables them |
| `TRUST_PROXY` | unset | `1` to read client IPs from `Fly-Client-IP` / `X-Forwarded-For` |
| `STATS_KEY` | unset | If set, `/api/stats` needs `?key=<value>` |

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

108 tests: every game rule in the rules engine (including simultaneous claims, the grace
window, wipeout and stall safeguards, reconnects, the finale, ties, and determinism), the answer
matcher (true positives and true negatives), the room actor (protocol, rate limits, hostile
input, reconnect), and validation of the committed category data.

## Balance simulation

Runs the real rules engine against simulated players on a virtual clock and rewrites
`reports/balance.md`:

```bash
npm run sim
```

Add `-- --grid` to also search a grid of candidate settings. The shipped defaults in
`src/shared/settings.ts` come from this report.

## Load test

Starts its own server, connects headless WebSocket players, plays full games to a winner, and
writes a report. It exits non-zero if any pass criterion fails.

```bash
npm run loadtest
```

```bash
npm run loadtest -- --rooms 3
```

Results on the development laptop (bots and server on the same machine; full reports in `reports/`):

| | 1 room x 400 | 3 rooms x 400 |
| --- | --- | --- |
| Result | pass | pass |
| Game length | 10.7 min | 9.6, 11.0 and 12.7 min |
| Submit to feedback, client-observed p50 / p95 / p99 | 0.4 / 0.8 / 4.3 ms | 0.4 / 3.9 / 15.4 ms |
| Submit handling, server-side p50 / p95 / p99 | 0.08 / 0.18 / 0.39 ms | 0.09 / 0.17 / 3.7 ms |
| Outbound messages/s, average / peak | 1,058 / 2,468 | 2,826 / 7,368 |
| Outbound kB/s, average / peak | 182 / 682 | 492 / 1,816 |
| Server CPU, % of one core, average / peak | 1.9 / 8.3 | 4.3 / 15.1 |
| Server memory (RSS), peak | 159 MB | 196 MB |
| Errors, desyncs, duplicate claims | 0 | 0 |

The latency target is p95 under 150 ms. These numbers measure the server, not real networks:
players' own connection latency comes on top.

Smaller run: `npm run loadtest -- --players 50` (about six minutes; add `--fast` for a shorter first fuse).
Use `--url http://host:port` to aim it at a server that is already running.

## Deploy

The app is one container that serves the client, the HTTP API and the WebSocket endpoint.
Rooms live in memory, so run **one instance**.

### Render (deploys on every push)

`render.yaml` is included (free instance, one region, health check on `/healthz`).

1. Push this repository to GitHub.
2. In the Render dashboard choose **New > Blueprint**, connect your GitHub account and pick the repository.
3. Approve the plan. The first build takes a few minutes; the service URL is `https://<name>.onrender.com`.

After that, every push to the linked branch rebuilds the Dockerfile and redeploys.

- A deploy restarts the process and ends every game in progress, so do not push during an event.
- The free instance sleeps after 15 minutes without traffic and takes about a minute to wake. Open the
  site a few minutes before players arrive, or change `plan` in `render.yaml` to a paid instance.
- `/api/stats` needs `?key=<STATS_KEY>`. Render generates the key; copy it from the service's
  **Environment** tab and URL-encode it.
- Submission logs are lost on every deploy and restart (free instances have no persistent disk).

### Fly.io

`fly.toml` is included (512 MB shared CPU, scales to zero when nobody is connected).

1. Install `flyctl` and sign in.
2. Change `app` in `fly.toml` to a name you own.
3. `fly launch --copy-config --no-deploy`, then `fly deploy`.
4. Keep it to one machine: `fly scale count 1`.
5. Optional: create a volume and uncomment `[mounts]` to keep submission logs across deploys.

### Any container host

```bash
docker build -t puff-royale .
```

```bash
docker run -p 8080:8080 puff-royale
```

The host must support WebSockets and must not run more than one instance behind a load balancer.
Health check path: `/healthz`.

### Scaling

One process handled three simultaneous 400-player rooms in the load test with a large margin.
Beyond one machine, route each room code to a fixed machine (see ARCHITECTURE.md section 9);
that routing is not built.

## Adding categories

Category files live in `data/categories/<id>.json`, one answer per line:

```json
{ "name": "Hippopotamus", "aliases": ["hippo"], "rarity": 0.3 }
```

`rarity` runs from 0 (everyone says it) to 1 (almost nobody does); 0.9 and above earns a heart
by default. You never need aliases for case, accents, punctuation, spacing, a leading "the", simple
plurals or small typos; the matcher handles those.

Three ways to add or change content:

1. **Edit the JSON** directly, then run `npm test` (it validates every file).
2. **Write a list** in the line-based authoring format described in `docs/category-format.md`
   (answers grouped under commonness tiers `@1`…`@5`, aliases after `|`) and compile it:

   ```bash
   npm run categories:import -- path/to/my-category.txt
   ```

   The importer removes duplicates and clashing aliases and prints a report. Add `--check` to validate without writing.
3. **Generate a draft with the Claude API** (needs Anthropic credentials), then review it:

   ```bash
   npm run categories:generate -- --id rivers --prompt "Name a river" --pack geography --count 300
   ```

`pack` groups categories; hosts can switch packs on and off in the lobby. A category is only used
while it has at least three times as many answers as players still alive, so add long lists if
you want them to appear early in big rooms.

### Rarity from real play

The server logs every evaluated submission to `data/logs/submissions-YYYY-MM-DD.jsonl`
(category, normalized text, result; no player identity). After some games:

```bash
npm run rarity:recompute
```

prints how scores would change and the most common unrecognised answers per category (good
candidates for new answers or aliases). Add `-- --write` to update the category files.

## Project layout

```
src/shared/    wire protocol and settings, shared by server, client and bots
src/engine/    rules engine (pure, deterministic), answer matcher, client views of state
src/server/    HTTP + WebSocket server, room actor, room registry, submission log, metrics
src/client/    Preact app: home, player view, big-screen view
src/sim/       simulated-player model and the balance simulation
src/bots/      headless bot client, load test, room filler
scripts/       category import / generate, rarity recompute, dev runner
data/categories/  the committed answer bank (48 categories, about 33,000 answers)
test/          unit tests
```

## Known gaps and next steps

Not built, roughly in the order I would tackle them:

1. **Real-player tuning.** The defaults come from a simulated-player model that is a guess. After
   the first real events, re-tune from the submission logs (`npm run rarity:recompute`, then
   `npm run sim`). The in-game pace control absorbs some of the error but not all of it.
2. **Human review of the answer lists.** The 33,000 seed answers were written by an LLM and checked
   by script for duplicates and collisions, not read line by line. Expect a few wrong or debatable
   entries and some missing obvious ones; the unknown-answer report from real games is the
   fastest way to find the gaps.
3. **LLM judge for unknown answers.** Designed in ARCHITECTURE.md section 7 (off the hot path,
   cached verdicts, behind a flag); today unknown answers are rejected and logged.
4. **Host hand-over.** Host powers live in the creating browser. If the host loses that browser's
   storage mid-event, nobody can start the next game.
5. **Abuse protection for public rooms.** There is per-socket rate limiting, a small name
   blocklist and a per-IP cap on room creation, but no CAPTCHA, no kick/ban for the host, no
   profanity filter on answers shown in the feed, and room codes can be guessed (about 330,000
   combinations).
6. **Crash recovery.** A server restart ends every game in progress. Clients reconnect
   automatically but the room is gone.
7. **Multi-machine scaling.** One process is enough for many rooms; routing rooms across
   machines is designed but not built.
8. **Deploy verification.** The Docker image builds and runs locally; the Fly.io config has not
   been deployed. The Claude-API category generator type-checks but was not run (no API key here).
9. **Clients.** Tested in a desktop browser at phone and projector sizes, not on physical phones.
   No sound, no localisation, no screen-reader pass beyond basic labels and live regions.
10. **Finale on the big screen** and reactions are functional but plain; the answer rain shows a
    sample, never all claims, by design.
