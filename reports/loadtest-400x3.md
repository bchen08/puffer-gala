# Load test: 3 rooms x 400 players

**Result: PASS**

Run on 2026-11-15 with `npm run loadtest -- --rooms 3`.
1200 headless WebSocket bots and the server on the same machine (darwin arm64, Node v24.21.0).
Bots answer from the category bank using the simulated-player model in `src/sim/behavior.ts` (think and typing delays, typos, unknown answers, players who are away); each bot also drops its socket with probability 0.002 per round and reconnects with its token.

## Games

| Room | Players | Game minutes | Main rounds | Winner | Bots that saw the end |
| --- | --- | --- | --- | --- | --- |
| BTSH | 400 | 11.0 | 31 | Bot 1-315 | 400/400 |
| CSVK | 400 | 12.7 | 39 | Bot 2-322 | 400/400 |
| YSAL | 400 | 9.6 | 33 | Bot 3-248 | 400/400 |

## Latency: submission to feedback

| Measure | p50 | p95 | p99 | max | samples |
| --- | --- | --- | --- | --- | --- |
| Client-observed round trip, ms (includes localhost network and the bot process's own scheduling) | 0.4 | 3.9 | 15.4 | 30.7 | 15346 |
| Server-side handling, ms (message received to result written) | 0.085 | 0.171 | 3.699 | 8.849 | 15346 |
| Server event-loop delay, ms (sampled every 10 ms; an idle process reads about 11) | 11.5 | - | 17.0 | 48.5 | - |
| Bot process event-loop delay, ms (same scale) | 11.7 | - | 12.5 | 30.5 | - |

Target: p95 under 150 ms.

## Throughput and resources (server process, game start to end)

| Measure | Average | Peak (1 s window) |
| --- | --- | --- |
| Outbound messages/s | 2826 | 7368 |
| Outbound kB/s | 491.5 | 1815.7 |
| Inbound messages/s | 139 | - |
| CPU, % of one core | 4.3 | 15.1 |
| Memory RSS, MB | - | 196 |
| JS heap used, MB | - | 61 |

Totals: 2160410 messages and 375.7 MB out over 12.7 minutes (313 kB per player). Average outbound message 174 bytes. Connecting 1200 bots took 0.2 s.

## Correctness

- Submission results: invalid 953, ok 11662, taken 2708, closed 23.
- Forced reconnects mid-game: 35.
- Server: 0 malformed frames, 0 sockets closed by the server, 0 ticks skipped for slow sockets.
- Client errors: 0.
- Desyncs: 0. Each bot checks its hearts against what it expects after every pop, that the alive count never rises, and that no answer is accepted twice in a category.
- Every room ended with exactly one winner and a final place for every bot: yes.
