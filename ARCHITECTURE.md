# Puff Royale — Architecture

A browser-based, real-time category elimination game for 300–400 players in one room.
Everyone answers the same category prompt against a shared fuse; unique answers survive,
the last player floating wins.

This document records each major decision, the options considered, and why one was chosen.
Numbers marked **(measured)** come from the load test in `reports/`; everything else is a
back-of-envelope estimate made before the code was written.

## 1. Summary of decisions

| Area | Choice | One-line reason |
| --- | --- | --- |
| Realtime transport | Plain WebSocket, JSON text frames | Bidirectional, universal on phones, no library needed on the client |
| Server runtime | One Node.js process, `ws` library, each room an in-process actor | Smallest moving-part count; a room needs ~5% of a core, so one process per room is unnecessary |
| Room/state model | Server-authoritative pure rules engine `apply(state, event) → effects`, driven by a thin room actor | Deterministic, replayable, testable without sockets |
| Fan-out | 5 Hz batched room tick + private per-player results | 2,000 msgs/s at 400 players instead of O(n²) event broadcast |
| Persistence | None for game state (rooms are ephemeral, in memory). Append-only JSONL for the submission log | A game lasts 10 minutes; durability would cost more than it protects |
| Answer data | JSON files in `data/categories/`, loaded into memory at boot | Easy to diff, edit, and review in pull requests; no database to run |
| Matching | Normalize → exact/alias hash lookup → bounded Damerau-Levenshtein with length-scaled tolerance | Microseconds per submission; strict by default |
| Client | Preact + Vite, TypeScript | React-style components at ~4 kB runtime; fast on cheap phones |
| Shared code | One package; `src/shared` and `src/engine` are imported by server, client, bots, and simulation | Protocol types cannot drift |
| Deployment | One Docker container (Fly.io config included; any container host works) | One process serves the static client and the WebSocket endpoint |

Runtime dependencies: `ws`, `preact`, `qrcode-generator`. Dev dependencies: `typescript`, `vite`,
`@preact/preset-vite`, `vitest`, `@types/node`, `@types/ws`, and `@anthropic-ai/sdk` (used only by
the optional category generation script). Node 24 runs the TypeScript sources directly, so the
server has no build step and no TypeScript runner dependency.

## 2. Realtime transport and hosting

### Options

**A. Node.js process with `ws`; rooms are actors inside the process (chosen).**
- Pros: boring and well understood; the whole stack runs locally with one command; CPU, memory
  and event-loop delay are directly measurable, which the load test needs; real wall clock and
  ordinary timers; no vendor account required to develop; a container runs anywhere.
- Cons: scaling past one machine needs room-affinity routing (section 9); a process crash loses
  every room on it; no scale-to-zero unless the host provides it.

**B. Cloudflare Durable Objects (directly or via PartyKit/PartyServer).**
- Pros: one object per room is exactly the actor model; global edge; a generous free tier
  (100k requests/day with incoming WebSocket messages billed 20:1, so a 400-player game costs
  roughly 1–2k request-equivalents); nothing to operate.
- Cons: the Workers runtime freezes `Date.now()` between I/O events, so server-side latency
  cannot be measured from inside the object; a 128 MB memory cap per object, shared with the
  category bank; a 5 Hz tick keeps the object from hibernating, so the hibernation API's
  benefit disappears during play; local development and the 400-bot load test run through
  `workerd`, where CPU and memory are harder to observe; deploy and debugging are tied to one vendor.

**C. Colyseus.**
- Pros: rooms, matchmaking, reconnection, and state sync are built in.
- Cons: its main feature, automatic delta-synchronised state for every client, is the thing
  this design must avoid at 400 players (section 5). Using Colyseus while bypassing its state
  sync leaves a room registry and a reconnection helper, which are ~150 lines here.

**D. Managed pub/sub (Ably, Pusher, Supabase Realtime).**
- Pros: connection handling and fan-out are someone else's problem.
- Cons: the game still needs an authoritative server for ordering and validation, so this adds
  a hop rather than removing a component. "First arrival wins" would be decided after an extra
  network leg. Free tiers cap concurrent connections (typically 100–200) and messages; one
  400-player game is about 1.3 million outbound messages, which exhausts the free allowances
  of the providers named above.

### Decision

**A**, with the room actor written against a five-method connection interface
(`send`, `close`, `bufferedAmount`, and the `onMessage`/`onClose` callbacks) rather than against `ws`
directly. The rules engine and room actor import nothing from Node, so option B remains a port
of one adapter file (~100 lines) if edge hosting or the free tier becomes the priority. It is a
close call between A and B; A wins on testability and measurability for an MVP whose exit
criterion is a load test.

One process per room (the alternative in the brief) was rejected: capacity math (section 6) puts
a full room at roughly 5% of one core and ~15 MB, so process isolation would buy crash isolation
at the cost of a process supervisor and port routing. Rooms are still fully independent actors;
they share only the read-only category bank and the event loop.

## 3. Room and state model

```
        WebSocket frames                       events                    effects
client ─────────────────▶ Room actor ────────────────────▶ Rules engine ─────────▶ Room actor ──▶ sockets
                          (validation,          apply(state, event)                (fan-out,
                           rate limit,          pure: no I/O, no clock,             batching,
                           tokens, tick)        no Math.random                      logging)
```

**Rules engine (`src/engine/engine.ts`).** A single function `apply(state, event)` that returns a list of
effects. It performs no I/O, never reads the clock (every event carries the server time `t`), and
draws randomness from a seeded PRNG whose state lives inside `GameState`. Given the same seed and
the same event list it produces the same game, which makes unit tests, the balance simulation
and bug replays the same mechanism. For speed it updates the state object in place rather than
copying 400 players on every submission; "pure" here means deterministic and side-effect-free
outside the state it is given.

**Room actor (`src/server/room.ts`).** Owns one `GameState`, the set of connections, reconnect tokens,
rate-limit buckets, and the feed buffer. All of a room's work happens in synchronous callbacks on
the Node event loop, so each room is effectively single-threaded: submissions are ordered by
arrival at the process, which is the definition of "first arrival wins".

**Phases.** `lobby → countdown → round → reveal → round → … → countdown → finale → ended`.
The engine exposes `wakeAt`, the next time it needs a `tick` event. A process-wide 50 ms
interval calls `room.advance(now)` for every room; the room forwards a `tick` to the engine
when `now ≥ wakeAt` and broadcasts on every fourth call (5 Hz).

**Alternatives considered.** (1) Mutable game objects with timers inside the game logic: fewer lines,
but untestable without fake timers and not replayable. (2) Event sourcing with a persisted log:
gives crash recovery, but a 10-minute party game does not justify it. (3) CRDT/state-sync
frameworks: solve a problem (concurrent writers) this game does not have, since the server is the
only writer.

### Pacing and guaranteed termination

- The fuse shrinks a little every main round (`fuseDecay`) down to a floor.
- **Stall safeguard.** If fewer than `stallFraction` (18%) of alive players lose a heart in a round,
  pressure rises one level and the next fuse is multiplied by 0.87, down to an absolute floor of 4 s.
- **Relief.** If more than half the room loses a heart, pressure drops one level (to at most three
  levels of relief). Together these act as a simple two-way controller that keeps the game moving
  at a similar pace whether the room is fast or slow, which matters because the simulated-player
  model that set the defaults is a guess.
- **Wipeout safeguard.** A pop that would eliminate every remaining player eliminates nobody.
- **Hard stops.** Three wipeout saves in a row, 60 main rounds, or 300 finale turns end the game by
  tie-break (most answers, then most rare answers, then hearts, then earliest seat), so no
  behaviour by players can make a game run forever.

### Timing and fairness

- Every deadline is sent as an absolute server timestamp. Clients estimate the clock offset with
  a ping/pong exchange (five samples at connect, then one every 10 s, keeping the lowest-RTT
  sample) and animate the puffer from `serverNow = Date.now() + offset`.
- **Grace window: 250 ms.** A round's displayed deadline is `D`; the engine pops at `D + 250 ms`.
  A submission sent just before a player's screen shows the pop still counts if it reaches the
  server within the window. With the 50 ms scheduler granularity the effective window is 250–300 ms.
- The category is not sent until the round starts, so nobody can prepare during the countdown.

### Robustness

- **Reconnect.** Joining returns a random 128-bit token, stored in `localStorage` per room code.
  Presenting it re-attaches the socket to the same seat and returns a full snapshot (phase,
  deadlines, own hearts and answer, recent claims). A second socket for the same seat replaces the first.
- **Idempotent submissions.** Each submission carries a client sequence number. The engine stores
  the last sequence and result per player; a repeated sequence returns the stored result without
  being evaluated again.
- **Hostile input.** Frames over 512 bytes close the socket (enforced by `ws`). Non-JSON, wrong
  types, and unknown message kinds are counted and dropped; 20 of them close the socket. Names
  are trimmed to 16 characters, stripped of control characters, checked against a small blocklist,
  and de-duplicated. Answer text is cut to 60 characters before matching.
- **Rate limit.** Token bucket per connection: 6 submissions burst, refilled at 3/s. A hard cap of
  30 messages/s of any kind closes the socket.
- **Slow clients.** Ticks are droppable because each carries absolute counters. If a socket has more
  than 64 kB buffered the tick is skipped for that client; over 1 MB the socket is closed.

## 4. Persistence

| Data | Option chosen | Alternatives | Why |
| --- | --- | --- | --- |
| Game and room state | In memory only | SQLite/Redis snapshot per tick; event log | A crash ends the games in progress. Acceptable for an MVP; recovery would need state plus all sockets to re-attach, and clients already reconnect automatically, so adding snapshots later is contained to the room actor |
| Category bank | JSON files in the repo, loaded at boot | SQLite file; a hosted database | Content is small (a few MB), changes by pull request, and must work offline |
| Submission log | Append-only JSONL, one file per day, buffered and flushed every 2 s | SQLite table; a hosted analytics store | Zero dependencies, greppable, trivially shipped elsewhere later. Writes never block a submission |

Submission log schema (one JSON object per line):

```ts
{ ts: number,        // server time, ms
  room: string,      // room code
  game: number,      // game number within the room
  round: number,
  cat: string,       // category id
  norm: string,      // normalized text the player typed
  res: "ok" | "taken" | "invalid",
  ans?: string }     // canonical answer when it matched
```

No player identifier is logged; rarity needs frequencies, not identities.
`scripts/recompute-rarity.ts` reads these files and rewrites rarity scores (section 7).

## 5. Fan-out and the wire protocol

Broadcasting every claim to every player is O(n²): 400 players producing ~40 claims/s at peak
would be 16,000 messages/s. Instead there are two channels.

**Room-wide tick, 5 Hz.** One JSON string is built per tick and the same string is written to every
socket. It carries only aggregates:

```json
{"t":"k","n":1731700000000,"al":214,"an":97,"c":391,"f":[["Capybara","Mina",1],["Otter","Jo",0]],"x":{"🔥":4}}
```

`n` server time, `al` alive, `an` answered this round, `c` connected, `f` a sample of at most 8
claims since the last tick (rare ones kept first), `x` reaction counts. Typical size 90–330 bytes.
A tick with no change is skipped, except for a 1 Hz keep-alive.

Why 5 Hz: the puffer is animated on the client from the deadline, so the tick only moves counters
and feeds text. A 200 ms update interval reads as live for a counter; 10 Hz would double the
dominant server cost (socket writes) for no visible difference, and 2 Hz makes the answer feed
look bursty.

**Phase changes.** A full public snapshot of the new phase (category, deadline, pop summary, finale
line-up) is sent to everyone when the phase changes: 2 per main round, one per turn in the finale.
150–600 bytes.

**Private messages.** Submission results and heart changes go only to the affected player.
Roughly 50–110 bytes each.

Never sent: the full player list. Lobby shows a count and the most recent names; standings show
the top 10 plus the viewer's own place. The finale line-up (at most `finaleSize` players) is the
only per-player list on the wire.

## 6. Capacity math (400 players, one room)

These are the estimates made before the code was written. Assumptions: 20 s fuse, 5 s reveal, each
player averages ~1.8 submissions per round (retries after "taken"), clock ping every 10 s.

| Flow | Messages/s | Bytes/s | Notes |
| --- | --- | --- | --- |
| Inbound submissions, average | 400 × 1.8 / 25 s ≈ 30 | ~2 kB | ~60 B each |
| Inbound submissions, peak (first 3 s of a round) | ~150 | ~9 kB | |
| Inbound pings | 40 | ~1.5 kB | |
| Outbound ticks | 5 × 400 = 2,000 | ~400 kB (200 B avg) | dominant term |
| Outbound private results | 30 avg, 150 peak | ~3–15 kB | |
| Outbound phase snapshots | 2 × 400 / 25 s ≈ 32 avg, bursts of 400 | ~10 kB avg | |
| Outbound pongs | 40 | ~2 kB | |
| **Total outbound** | **≈ 2,100–2,600** | **≈ 0.4–0.5 MB/s** | ≈ 1.1 kB/s per client |

A 10-minute game is therefore about 1.3 M outbound messages and ~270 MB of egress in total
(~0.7 MB per player), comfortably inside phone data budgets and a rounding error on hosting bills.

**Memory.** Game state is ~1 kB per player (0.5 MB per room). Node keeps roughly 15–25 kB per
WebSocket (socket, buffers, `ws` wrapper), so 400 sockets ≈ 6–10 MB. One full room ≈ 10–15 MB.
The category bank is shared by all rooms: ~33k answers with ~4 index keys each ≈ 20–30 MB. Process
baseline ~60 MB. A 256 MB machine fits several full rooms; 512 MB is comfortable.

**CPU.** Per submission: JSON parse, a hash lookup (fuzzy fallback under ~0.2 ms in the worst case),
a small state update, one send: ~20–50 µs, so 150/s is under 1% of a core. Fan-out: 2,000
`socket.write` calls per second at 10–20 µs each (mostly kernel time) ≈ 2–4% of a core. A full
room should sit around 3–6% of one core.

**Bottleneck.** Outbound socket writes: the tick fan-out is over 90% of all messages. It scales
with `players × tick rate`, which is why the tick is capped at 5 Hz and skipped when nothing
changed. After that the limit is the single event loop: at an estimated 5% of a core per full
room, one core carries on the order of 10 full rooms before tick jitter grows. TLS is terminated
at the host's proxy, not in the Node process.

**Latency.** Server-side processing of a submission is synchronous and well under a millisecond; the
150 ms p95 target is therefore a budget for event-loop queueing, which only grows if the loop is
saturated. The load test reports both server processing time and event-loop delay.

### Measured (load test, bots and server on one laptop)

| | Estimate | Measured, 1 room x 400 | Measured, 3 rooms x 400 |
| --- | --- | --- | --- |
| Outbound messages/s, peak | 2,100–2,600 | 2,468 | 7,368 |
| Outbound messages/s, average over the game | (not estimated) | 1,058 | 2,826 |
| Outbound bytes/s, peak / average | 0.4–0.5 MB/s | 0.68 MB/s / 0.18 MB/s | 1.8 MB/s / 0.49 MB/s |
| Egress per player per game | ~0.7 MB | 0.29 MB | 0.31 MB |
| Server-side submit handling, p95 / p99 | well under 1 ms | 0.18 ms / 0.39 ms | 0.17 ms / 3.7 ms |
| Client-observed round trip on localhost, p95 / p99 | (budget 150 ms) | 0.8 ms / 4.3 ms | 3.9 ms / 15.4 ms |
| CPU, share of one core, average / peak second | 3–6% | 1.9% / 8.3% | 4.3% / 15.1% |
| Process memory (RSS), peak | ~90 MB | 159 MB | 196 MB |

Where the estimates were off: the average message rate is half the peak because the field shrinks
during the game and unchanged ticks are skipped; peak bytes are higher than estimated because the
tick at the start of a round carries a full feed sample; memory is higher than estimated, mostly
the category bank's match indexes, and is shared by all rooms. The conclusion holds: the server is
far from any limit at this scale, and the tick fan-out is the dominant cost.

A caveat on the latency numbers: bots and server share a machine, so they measure the server and
the event loop, not real networks. Real players will see their own network latency on top
(typically 30–150 ms on mobile), which is what the 250 ms grace window is for.

Full reports: `reports/loadtest-400x1.md` and `reports/loadtest-400x3.md`.

## 7. Answer data and matching

### Format

One JSON file per category in `data/categories/`:

```json
{
  "id": "animals",
  "prompt": "Name an animal",
  "pack": "nature",
  "tags": ["nature", "kids"],
  "difficulty": 1,
  "answers": [
    { "name": "Hippopotamus", "aliases": ["hippo"], "rarity": 0.3 }
  ]
}
```

Alternatives: a single SQLite file (harder to review in a diff, needs a native or experimental
driver) and CSV (awkward for alias lists). JSON, one answer per line, diffs cleanly.

### Seed content and generation

The seed set (48 categories, about 33,000 answers; ten categories have more than 1,400 answers) was
written by an LLM from its own knowledge, with no scraping and no third-party answer lists, then
compiled and validated by `scripts/import-categories.ts` (de-duplication by normalized key,
alias-collision removal). A test checks that every name and alias in the committed files matches
back to its own answer. The lists have not been reviewed line by line by a person. `scripts/generate-category.ts` produces further categories through the Claude API in the
same intermediate text format. The committed JSON is all the server needs; it makes no external calls.

### Rarity

Method for the seed data: the generating model placed each answer in one of five commonness tiers
("how likely is a typical player to think of this within 20 seconds"), mapped to rarity
0.1 / 0.3 / 0.5 / 0.7 / 0.9. This is a prior, not a measurement. The default heart threshold is
0.9 (the top tier, 20-25% of each list): with 0.7 the simulation showed hearts being earned
faster than they were lost. Wikipedia pageviews were
considered and rejected for the MVP: they need per-answer entity resolution and network access at
build time, and popularity of a page is only loosely related to what people type under time pressure.

Recompute: `scripts/recompute-rarity.ts` reads the submission logs, counts how often each answer
was attempted (accepted or taken; both mean "a player thought of it"), ranks answers within the
category, and blends the empirical percentile with the prior, weighted by sample size. It also
prints the most frequent unrecognised submissions per category for review.

### Matching

Pipeline, in order, stopping at the first hit:

1. **Normalize**: lowercase, strip diacritics (NFD), `&` → `and`, drop a leading article
   (`the`, `a`, `an`), remove punctuation and all whitespace. `"The Hot-Dog"` → `hotdog`.
2. **Exact key**: canonical names and aliases, in a per-category hash map.
3. **Derived key**: simple plural and singular variants generated at index time
   (`cats`, `boxes`, `berries` ↔ `berry`). A variant that could mean two different answers is discarded.
4. **Fuzzy**: optimal-string-alignment (Damerau-Levenshtein with adjacent transposition) against
   keys with the same first letter and a length within the tolerance. Tolerance by key length:
   under 5 characters none; 5–9 one edit; 10 or more two edits. Digits must match exactly
   (`Apollo 13` never matches `Apollo 11`). If two different answers tie at the best distance the
   submission is rejected.

The bias is deliberately toward false negatives: a rejected near-miss costs the player a retry
with instant feedback, while a false positive hands out a wrong claim that also blocks the real answer.

Cost: steps 1–3 are O(length). Step 4 only runs on a miss and compares against a bucket of
typically 10–60 keys with an early-exit banded distance, tens of microseconds. All inline.

Alternatives: trigram or BK-tree indexes (unnecessary at ≤ 2k answers per category), phonetic
matching (too many false positives), embedding similarity (slow, and cannot be made strict).

### Unknown answers and the optional LLM judge (not built)

The MVP rejects unknown answers and logs them. Design for a later judge, behind `LLM_JUDGE=1`:
an unrecognised submission is still answered `invalid` immediately; in the background the
normalized text is looked up in a verdict cache (`data/verdicts.jsonl`, keyed by category and
normalized text) and, on a miss, queued for a batched model call ("is X a valid answer for
category Y; if so give the canonical name"). Positive verdicts are appended to the cache and
merged into the in-memory index, so the answer is accepted from the next submission onward.
The hot path never waits on the model, and each unknown string is judged at most once.

## 8. Client

| Option | Verdict |
| --- | --- |
| **Preact + Vite (chosen)** | Component model everyone knows, ~4 kB runtime, TypeScript and JSX out of the box |
| React | Same model, ~45 kB more JavaScript for no benefit on a three-screen app |
| Svelte / Solid | Fine choices, smaller talent pool, a second compiler to learn |
| No framework | Feasible, but six views with shared live state would reinvent a small framework |

State lives in one small store fed by the WebSocket; components subscribe to it. The puffer is an
SVG driven by `requestAnimationFrame` from the server-synchronised clock, so it stays smooth
between 5 Hz ticks. No UI lists individual players beyond the finale line-up; everything else is
counts, samples, and the viewer's own state.

Routes: `/` (create or join), `/r/CODE` (player and spectator), `/r/CODE/screen` (projector view
with QR code, answer rain, finale spotlight).

## 9. Deployment and cost

One container serves the built client, the HTTP API, and `/ws`.

- **Fly.io** (config included): a `shared-cpu-1x`, 512 MB machine is about $3/month running
  continuously, and with auto-stop it is billed only while someone is connected. Egress for a
  full 400-player game is ~0.3 GB (cents).
- **Render free tier** or any container host works for development and small events; a free
  instance sleeps when idle and takes up to a minute to wake.
- **Local**: `npm start`.

**Scaling beyond one machine** (not built): rooms are independent, so run N machines and route by
room code, for example by encoding the machine id in the code's first letter and using Fly's
`fly-replay` header on the WebSocket upgrade. No shared state is needed.

## 10. Assumptions

- A dropped process ends its games; this is acceptable for an MVP.
- The host is trusted with their own room; rooms are unlisted and reachable only by code.
- English-language content and Latin-script input.
- Players are on phones with reasonable connectivity; 250 ms of grace covers typical mobile latency.
- The host can play, run the big screen, or both: host powers come from a host key held in the
  creating browser, not from a seat.
- Players who are disconnected at the moment a game starts sit that game out as spectators.
- The simulated-player model behind the balance report is an informed guess; real events will
  need the defaults re-tuned from the submission log.
- "Play again" returns the room to the lobby with everyone seated, so the host can adjust settings.
- A wipeout that repeats three rounds in a row (for example, every remaining player is away) ends
  the game and picks the winner by tie-break rather than looping forever.
