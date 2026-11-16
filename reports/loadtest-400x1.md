# Load test: 1 room x 400 players

**Result: PASS**

Run on 2026-11-15 with `npm run loadtest`.
400 headless WebSocket bots and the server on the same machine (darwin arm64, Node v24.21.0).
Bots answer from the category bank using the simulated-player model in `src/sim/behavior.ts` (think and typing delays, typos, unknown answers, players who are away); each bot also drops its socket with probability 0.002 per round and reconnects with its token.

## Games

| Room | Players | Game minutes | Main rounds | Winner | Bots that saw the end |
| --- | --- | --- | --- | --- | --- |
| NTGZ | 400 | 10.7 | 37 | Bot 1-195 | 400/400 |

## Latency: submission to feedback

| Measure | p50 | p95 | p99 | max | samples |
| --- | --- | --- | --- | --- | --- |
| Client-observed round trip, ms (includes localhost network and the bot process's own scheduling) | 0.4 | 0.8 | 4.3 | 17.5 | 5327 |
| Server-side handling, ms (message received to result written) | 0.077 | 0.177 | 0.388 | 5.734 | 5327 |
| Server event-loop delay, ms (sampled every 10 ms; an idle process reads about 11) | 11.0 | - | 12.0 | 35.3 | - |
| Bot process event-loop delay, ms (same scale) | 11.0 | - | 11.6 | 30.1 | - |

Target: p95 under 150 ms.

## Throughput and resources (server process, game start to end)

| Measure | Average | Peak (1 s window) |
| --- | --- | --- |
| Outbound messages/s | 1058 | 2468 |
| Outbound kB/s | 182.3 | 682.0 |
| Inbound messages/s | 48 | - |
| CPU, % of one core | 1.9 | 8.3 |
| Memory RSS, MB | - | 159 |
| JS heap used, MB | - | 42 |

Totals: 683179 messages and 117.7 MB out over 10.8 minutes (294 kB per player). Average outbound message 172 bytes. Connecting 400 bots took 0.1 s.

## Correctness

- Submission results: invalid 330, ok 4052, taken 937, closed 8.
- Forced reconnects mid-game: 10.
- Server: 0 malformed frames, 0 sockets closed by the server, 0 ticks skipped for slow sockets.
- Client errors: 0.
- Desyncs: 0. Each bot checks its hearts against what it expects after every pop, that the alive count never rises, and that no answer is accepted twice in a category.
- Every room ended with exactly one winner and a final place for every bot: yes.
