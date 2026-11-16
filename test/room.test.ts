import { describe, expect, it } from 'vitest';
import { buildBank } from '../src/engine/matcher.ts';
import { packInfo } from '../src/server/registry.ts';
import { LIMITS, Room, type Conn, type LogEntry } from '../src/server/room.ts';
import { cleanName, isBlockedName, isRoomCode, randomRoomCode, uniqueName } from '../src/server/names.ts';
import type { ServerMsg } from '../src/shared/protocol.ts';
import { applyHostSettings, DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { makeCategory } from './helpers.ts';

class FakeConn implements Conn {
  sent: ServerMsg[] = [];
  closed: number | null = null;
  buffered = 0;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  of<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> {
    const all = this.of(t);
    if (!all.length) throw new Error(`no ${t} message`);
    return all[all.length - 1];
  }
}

const bank = buildBank([makeCategory('big', 2000), makeCategory('other', 2000, 'second')]);

class World {
  now = 1_000_000;
  logs: LogEntry[] = [];
  room = new Room('ABCD', 'host-key', this.now, { bank, packs: packInfo(bank), log: (e) => this.logs.push(e), seed: 7 });

  open(): FakeConn {
    const conn = new FakeConn();
    this.room.onOpen(conn, this.now);
    return conn;
  }
  say(conn: FakeConn, msg: unknown): void {
    this.room.onMessage(conn, typeof msg === 'string' ? msg : JSON.stringify(msg), this.now);
  }
  join(name: string, extra: Record<string, unknown> = {}): FakeConn {
    const conn = this.open();
    this.say(conn, { t: 'hello', role: 'player', name, ...extra });
    return conn;
  }
  /** Advances the clock in 50 ms steps, as the server loop does. */
  run(ms: number): void {
    for (let i = 0; i < ms / 50; i++) {
      this.now += 50;
      this.room.advance(this.now);
    }
  }
  /** Runs until the room reaches `phase` (bounded). */
  until(phase: string, maxMs = 120_000): void {
    for (let i = 0; i < maxMs / 50 && this.room.state.phase !== phase; i++) this.run(50);
    if (this.room.state.phase !== phase) throw new Error(`never reached ${phase}, at ${this.room.state.phase}`);
  }
}

function lobby(n: number) {
  const w = new World();
  const host = w.join('Host', { hostKey: 'host-key' });
  const others = Array.from({ length: n - 1 }, (_, i) => w.join(`Player ${i + 1}`));
  return { w, host, others, all: [host, ...others] };
}

describe('joining', () => {
  it('welcomes a player with a token, their seat and the lobby', () => {
    const w = new World();
    const c = w.join('  Ada  ');
    const welcome = c.last('welcome');
    expect(welcome).toMatchObject({ code: 'ABCD', role: 'player', host: false, phase: { ph: 'lobby', seats: 1 } });
    expect(welcome.token).toMatch(/^[\w-]{20,}$/);
    expect(welcome.me).toMatchObject({ name: 'Ada', status: 'lobby' });
    expect(welcome.packs.map((p) => p.id)).toEqual(['second', 'test']);
    expect(welcome.phase.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('requires a usable name and makes names unique and clean', () => {
    const w = new World();
    const noName = w.join('   ');
    expect(noName.last('error').code).toBe('name');
    expect(w.room.state.players.size).toBe(0);
    // The same socket can try again.
    w.say(noName, { t: 'hello', role: 'player', name: 'Ada' });
    expect(noName.last('welcome').me?.name).toBe('Ada');
    expect(w.join('ada').last('welcome').me?.name).toBe('ada 2');
    expect(w.join('A'.repeat(50)).last('welcome').me?.name).toBe('A'.repeat(16));
    expect(w.join('<b>Bob\u0000​</b>').last('welcome').me?.name).toBe('bBob/b');
    expect(w.join('sh1thead').last('welcome').me?.name).toMatch(/^Puffer \d+$/);
  });

  it('refuses a new seat when the room is full', () => {
    const { w, host } = lobby(2);
    w.say(host, { t: 'config', settings: { maxPlayers: 2 } });
    const extra = w.join('Late');
    expect(extra.last('error').code).toBe('full');
    expect(w.room.state.players.size).toBe(2);
  });

  it('gives the big screen the same public state without a seat', () => {
    const { w, host } = lobby(3);
    const screen = w.open();
    w.say(screen, { t: 'hello', role: 'screen' });
    expect(screen.last('welcome')).toMatchObject({ role: 'screen', me: null, phase: { ph: 'lobby', seats: 3 } });
    expect(screen.last('welcome').token).toBeUndefined();
    w.say(screen, { t: 'submit', seq: 1, text: 'w1' });
    w.say(host, { t: 'start' });
    expect(screen.last('phase').ph).toBe('countdown');
    expect(w.room.state.players.size).toBe(3);
  });

  it('frees a lobby seat on disconnect and restores it with the token', () => {
    const { w, others } = lobby(3);
    const token = others[0].last('welcome').token!;
    w.room.onClose(others[0], w.now);
    expect(w.room.state.players.size).toBe(2);
    const back = w.join('ignored', { token });
    expect(back.last('welcome').me?.name).toBe('Player 1');
    expect(w.room.state.players.size).toBe(3);
  });
});

describe('host controls', () => {
  it('lets only the host configure, start and restart', () => {
    const { w, host, others } = lobby(3);
    for (const t of ['config', 'start', 'again']) {
      w.say(others[0], { t, settings: { startHearts: 5 } });
      expect(others[0].last('error').code).toBe('nothost');
    }
    expect(w.room.state.phase).toBe('lobby');
    expect(w.room.state.settings.startHearts).toBe(DEFAULT_SETTINGS.startHearts);
    w.say(host, { t: 'config', settings: { startHearts: 3, fuseMs: 30000, packs: ['test'] } });
    expect(w.room.state.settings).toMatchObject({ startHearts: 3, fuseMs: 30000, packs: ['test'] });
    expect(others[1].last('phase').settings?.startHearts).toBe(3);
    w.say(host, { t: 'start' });
    expect(w.room.state.phase).toBe('countdown');
  });

  it('rejects a wrong host key', () => {
    const w = new World();
    const c = w.join('Mallory', { hostKey: 'guess' });
    expect(c.last('welcome').host).toBe(false);
  });

  it('will not start with fewer than two players', () => {
    const w = new World();
    const host = w.join('Host', { hostKey: 'host-key' });
    w.say(host, { t: 'start' });
    expect(host.last('error').code).toBe('needplayers');
    expect(w.room.state.phase).toBe('lobby');
  });

  it('clamps host settings to safe ranges and drops junk', () => {
    const s = applyHostSettings(
      DEFAULT_SETTINGS,
      { maxPlayers: 99999, startHearts: -3, fuseMs: 'fast', finaleSize: 4.6, packs: ['test', 'nope', 7], graceMs: 60000, maxHearts: 1 },
      ['test', 'second'],
    );
    expect(s).toMatchObject({ maxPlayers: 500, startHearts: 1, fuseMs: DEFAULT_SETTINGS.fuseMs, finaleSize: 5, packs: ['test'] });
    expect(s.graceMs).toBe(DEFAULT_SETTINGS.graceMs);
    expect(s.maxHearts).toBeGreaterThanOrEqual(s.startHearts);
    expect(applyHostSettings(DEFAULT_SETTINGS, null, [])).toEqual(DEFAULT_SETTINGS);
    expect(applyHostSettings(DEFAULT_SETTINGS, 'x', [])).toEqual(DEFAULT_SETTINGS);
  });
});

describe('playing', () => {
  function inRound(n = 12) {
    const game = lobby(n);
    game.w.say(game.host, { t: 'start' });
    game.w.until('round');
    return game;
  }

  it('sends deadlines as server timestamps to everyone at round start', () => {
    const { w, all } = inRound();
    for (const c of all) {
      const p = c.last('phase');
      expect(p).toMatchObject({ ph: 'round', round: 1, alive: 12, total: 12 });
      expect(p.deadline).toBe(w.room.state.deadline);
      expect(p.cat?.prompt).toMatch(/^Name a /);
    }
  });

  it('sends a submission result only to the submitter; others see the claim in the batched tick', () => {
    const { w, host, others } = inRound();
    const before = others[0].sent.length;
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    expect(host.last('result')).toMatchObject({ seq: 1, status: 'ok', answer: 'w1', hearts: 2 });
    expect(others[0].sent.length).toBe(before);
    w.run(200);
    const tick = others[0].last('k');
    expect(tick.f).toEqual([['w1', 'Host', 0]]);
    expect(tick).toMatchObject({ al: 12, an: 1, s: 12, c: 12 });
    expect(others[0].of('result')).toEqual([]);
    w.say(others[0], { t: 'submit', seq: 1, text: 'w1' });
    expect(others[0].last('result')).toMatchObject({ status: 'taken', by: 'Host' });
  });

  it('skips unchanged ticks except for a once-a-second keep-alive', () => {
    const { w, host } = inRound();
    w.run(1000);
    const before = host.of('k').length;
    w.run(2000);
    expect(host.of('k').length - before).toBe(2);
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    w.run(200);
    expect(host.of('k').length - before).toBe(3);
  });

  it('caps the feed sample per tick and keeps rare claims', () => {
    const { w, all } = inRound(14);
    all.forEach((c, i) => w.say(c, { t: 'submit', seq: 1, text: i === 0 ? 'w9' : `w${i + 20}` }));
    w.run(200);
    const f = all[1].last('k').f!;
    expect(f.length).toBe(LIMITS.feedPerTick);
    expect(f[0]).toEqual(['w9', 'Host', 1]);
  });

  it('rate-limits submissions per player', () => {
    const { w, host } = inRound();
    for (let i = 1; i <= LIMITS.submitBurst + 1; i++) w.say(host, { t: 'submit', seq: i, text: 'nope' });
    const results = host.of('result');
    expect(results.slice(0, LIMITS.submitBurst).every((r) => r.status === 'invalid')).toBe(true);
    expect(results[LIMITS.submitBurst].status).toBe('rate');
    w.run(1000); // refill
    w.say(host, { t: 'submit', seq: 20, text: 'w1' });
    expect(host.last('result').status).toBe('ok');
  });

  it('returns the same result for a retried submission', () => {
    const { w, host } = inRound();
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    expect(host.of('result')).toHaveLength(2);
    expect(host.of('result')[1]).toEqual(host.of('result')[0]);
    expect(w.room.state.answered).toBe(1);
  });

  it('pops at deadline + grace and tells each affected player privately', () => {
    const { w, host, others } = inRound();
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    const deadline = w.room.state.deadline;
    w.until('reveal');
    expect(w.now).toBeGreaterThanOrEqual(deadline + DEFAULT_SETTINGS.graceMs);
    expect(w.now).toBeLessThan(deadline + DEFAULT_SETTINGS.graceMs + 100);
    expect(others[0].last('me')).toMatchObject({ hearts: 1, status: 'alive' });
    expect(host.of('me').length).toBe(1); // only the start-of-game message; nothing changed for the host
    expect(host.last('phase')).toMatchObject({ ph: 'reveal', pop: { lost: 11, out: 0, aliveAfter: 12 } });
  });

  it('restores a reconnecting player mid-game and replaces the old socket', () => {
    const { w, host, others } = inRound();
    const token = others[0].last('welcome').token!;
    w.say(host, { t: 'submit', seq: 1, text: 'w1' });
    w.say(others[0], { t: 'submit', seq: 1, text: 'w2' });
    w.room.onClose(others[0], w.now);
    expect(w.room.state.players.size).toBe(12);

    const back = w.join('whatever', { token });
    const welcome = back.last('welcome');
    expect(welcome.me).toMatchObject({ name: 'Player 1', status: 'alive', hearts: 2, answer: 'w2', seq: 1 });
    expect(welcome.phase).toMatchObject({ ph: 'round', deadline: w.room.state.deadline });
    expect(welcome.recent).toEqual([['w1', 'Host', 0], ['w2', 'Player 1', 0]]);

    // A second tab with the same token takes over the seat.
    const tab = w.join('whatever', { token });
    expect(back.last('error').code).toBe('replaced');
    expect(back.closed).toBe(4001);
    w.say(tab, { t: 'submit', seq: 2, text: 'w3' });
    expect(tab.last('result').status).toBe('already');
    // The replaced socket closing later must not disconnect the seat.
    w.room.onClose(back, w.now);
    expect(w.room.state.players.get(welcome.me!.id)?.connected).toBe(true);
  });

  it('seats late joiners as spectators who see the game live', () => {
    const { w } = inRound();
    const late = w.join('Late');
    expect(late.last('welcome')).toMatchObject({ me: { status: 'waiting' }, phase: { ph: 'round' } });
    w.say(late, { t: 'submit', seq: 1, text: 'w1' });
    expect(late.last('result').status).toBe('out');
    w.run(1000);
    expect(late.of('k').length).toBeGreaterThan(0);
  });

  it('aggregates reactions into the tick', () => {
    const { w, host, others } = inRound();
    w.say(others[0], { t: 'react', e: '🔥' });
    w.say(others[1], { t: 'react', e: '🔥' });
    w.say(others[1], { t: 'react', e: '🔥' }); // too soon: ignored
    w.say(others[2], { t: 'react', e: '<script>' });
    w.run(200);
    expect(host.last('k').x).toEqual({ '🔥': 2 });
  });

  it('logs submissions with the room and game', () => {
    const { w, host } = inRound();
    w.say(host, { t: 'submit', seq: 1, text: 'W 1' });
    w.say(host, { t: 'submit', seq: 2, text: 'bogus' });
    expect(w.logs).toEqual([{ ts: w.now, room: 'ABCD', game: 1, round: 1, cat: w.room.state.categoryId, norm: 'w1', res: 'ok', ans: 'w1' }]);
  });

  it('plays a whole game to a winner, then returns to the lobby on play again', () => {
    const { w, host, all } = lobby(12);
    w.say(host, { t: 'config', settings: { fuseMs: 6000, finaleSize: 3 } });
    w.say(host, { t: 'start' });
    const seq = new Map<FakeConn, number>();
    let n = 0;
    for (let guard = 0; guard < 4000 && w.room.state.phase !== 'ended'; guard++) {
      w.run(250);
      const s = w.room.state;
      if (s.phase === 'round') {
        // The first half of the room answers every round; the rest never do.
        all.slice(0, 6).forEach((c) => {
          const me = c.last('me');
          if (me.status === 'alive' && w.room.state.players.get(me.id)!.answer < 0) {
            seq.set(c, (seq.get(c) ?? 0) + 1);
            w.say(c, { t: 'submit', seq: seq.get(c), text: `w${n++ * 10 + 1}` });
          }
        });
      }
    }
    expect(w.room.state.phase).toBe('ended');
    const end = host.last('phase').end!;
    expect(end.winner).toBeTruthy();
    expect(end.top[0].place).toBe(1);
    expect(end.players).toBe(12);
    expect(all.filter((c) => c.last('me').place === 1).length).toBe(1);
    expect(all.every((c) => c.last('me').place >= 1)).toBe(true);

    w.say(host, { t: 'again' });
    expect(w.room.state.phase).toBe('lobby');
    expect(all.every((c) => c.last('me').status === 'lobby')).toBe(true);
    expect(w.room.state.settings.fuseMs).toBe(6000);
  });
});

describe('hostile clients', () => {
  it('ignores garbage without crashing and closes a socket that keeps sending it', () => {
    const { w, host } = lobby(3);
    const bad = w.join('Chaos');
    const garbage = [
      'not json', '', '[]', 'null', '42', '"str"', '{"t":5}', '{"t":"nope"}', '{"t":"submit"}',
      '{"t":"submit","seq":"1","text":"x"}', '{"t":"submit","seq":1.5,"text":"x"}', '{"t":"submit","seq":-1,"text":"x"}',
      '{"t":"submit","seq":1,"text":{}}', '{"t":"ping"}', '{"t":"ping","c":"now"}', '{"t":"react","e":5}',
      '{"t":"hello","role":"admin"}', '{"__proto__":{"t":"start"}}', '{"t":"config"}',
    ];
    for (const g of garbage) w.say(bad, g);
    expect(bad.closed).toBeNull();
    expect(w.room.state.phase).toBe('lobby');
    // Two of the lines above are refused politely rather than counted as malformed.
    for (let i = 0; i < 4; i++) w.say(bad, '{"t":"nope"}');
    expect(bad.closed).toBe(4000);
    expect(w.room.state.players.size).toBe(3);
    // The room still works for everyone else.
    w.say(host, { t: 'start' });
    expect(w.room.state.phase).toBe('countdown');
  });

  it('closes a socket that floods messages', () => {
    const { w, others } = lobby(3);
    for (let i = 0; i <= LIMITS.messagesPerSec; i++) w.say(others[0], { t: 'ping', c: i });
    expect(others[0].closed).toBe(4000);
    expect(others[0].of('pong').length).toBe(LIMITS.messagesPerSec - 1); // the hello counted too
  });

  it('closes sockets that never say hello', () => {
    const w = new World();
    const silent = w.open();
    w.run(LIMITS.helloTimeoutMs + 400);
    expect(silent.closed).toBe(4000);
    expect(w.room.connections).toBe(0);
  });

  it('drops ticks for slow sockets and closes hopeless ones', () => {
    const { w, host, others } = lobby(3);
    others[0].buffered = LIMITS.softBufferBytes + 1;
    const before = others[0].sent.length;
    w.join('Newcomer'); // changes the seat count, so a tick goes out
    w.run(200);
    expect(host.of('k').length).toBeGreaterThan(0);
    expect(others[0].sent.length).toBe(before);
    others[0].buffered = LIMITS.hardBufferBytes + 1;
    w.say(host, { t: 'start' }); // phase messages are never dropped; a hopeless socket is closed instead
    expect(others[0].closed).toBe(4000);
  });

  it('answers pings with the server clock for offset estimation', () => {
    const w = new World();
    const c = w.join('Ada');
    w.say(c, { t: 'ping', c: 123.5 });
    expect(c.last('pong')).toEqual({ t: 'pong', c: 123.5, s: w.now });
  });
});

describe('names and codes', () => {
  it('cleans and filters names', () => {
    expect(cleanName('  Zoë   Q  ')).toBe('Zoë Q');
    expect(cleanName(42)).toBe('');
    expect(cleanName('\u0007​')).toBe('');
    expect(isBlockedName('F.u.c.k')).toBe(true);
    expect(isBlockedName('sh1t')).toBe(true);
    expect(isBlockedName('Dickens')).toBe(false);
    expect(isBlockedName('Grape Soda')).toBe(false);
    expect(uniqueName('Sam', new Set(['sam', 'sam 2']))).toBe('Sam 3');
  });

  it('generates four-letter codes without I or O', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomRoomCode();
      expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
      expect(isRoomCode(code)).toBe(true);
    }
    expect(isRoomCode('ABIO')).toBe(false);
    expect(isRoomCode('abcd')).toBe(false);
  });
});
