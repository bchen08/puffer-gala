import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MIN_FUSE_MS,
  MAX_FUSE_MS,
  MAX_MAIN_ROUNDS,
  MIN_PRESSURE,
  createGame,
  finaleFuse,
  pickCategory,
  roundFuse,
} from '../src/engine/engine.ts';
import { buildBank } from '../src/engine/matcher.ts';
import { endView, meView, phaseView } from '../src/engine/view.ts';
import { Harness, TEST_SETTINGS, makeCategory, snapshot } from './helpers.ts';

describe('lobby and start', () => {
  it('seats players and starts with a countdown', () => {
    const h = new Harness();
    const ids = h.join(6);
    expect(h.state.phase).toBe('lobby');
    expect(ids.every((id) => h.p(id).status === 'lobby')).toBe(true);
    h.start();
    expect(h.state.phase).toBe('countdown');
    expect(h.state.wakeAt).toBe(h.t + TEST_SETTINGS.countdownMs);
    expect(h.state.gameNo).toBe(1);
    expect(h.state.alive).toBe(6);
    expect(ids.every((id) => h.p(id).status === 'alive' && h.p(id).hearts === 2)).toBe(true);
  });

  it('needs at least two connected players', () => {
    const h = new Harness();
    h.join(1);
    h.start();
    expect(h.state.phase).toBe('lobby');
    h.join(1);
    h.send({ type: 'connection', t: h.t, pid: 'p1', connected: false });
    h.start();
    expect(h.state.phase).toBe('lobby');
    h.send({ type: 'connection', t: h.t, pid: 'p1', connected: true });
    h.start();
    expect(h.state.phase).toBe('countdown');
  });

  it('makes late joiners spectators until the next game', () => {
    const h = new Harness();
    h.join(6);
    h.start();
    h.toPlay();
    const [late] = h.join(1, 'late');
    expect(h.p(late).status).toBe('waiting');
    expect(h.submit(late, 'w1').status).toBe('out');
    expect(h.state.alive).toBe(6);
  });

  it('sits out players who are disconnected when the game starts', () => {
    const h = new Harness();
    h.join(6);
    h.send({ type: 'connection', t: h.t, pid: 'p5', connected: false });
    h.start();
    expect(h.p('p5').status).toBe('waiting');
    expect(h.state.startCount).toBe(5);
  });

  it('frees a seat when a player leaves the lobby and refuses joins when full', () => {
    const h = new Harness({ maxPlayers: 3 });
    h.join(3);
    expect(h.join(1, 'x')).toEqual(['x3']);
    expect(h.state.players.has('x3')).toBe(false);
    h.send({ type: 'leave', t: h.t, pid: 'p1' });
    expect(h.state.players.size).toBe(2);
    h.join(1, 'y');
    expect(h.state.players.size).toBe(3);
  });

  it('applies settings only in the lobby', () => {
    const h = new Harness();
    h.join(6);
    h.send({ type: 'configure', t: h.t, settings: { ...TEST_SETTINGS, startHearts: 4 } });
    expect(h.state.settings.startHearts).toBe(4);
    h.start();
    h.send({ type: 'configure', t: h.t, settings: { ...TEST_SETTINGS, startHearts: 1 } });
    expect(h.state.settings.startHearts).toBe(4);
    expect(h.p('p0').hearts).toBe(4);
  });
});

describe('main rounds', () => {
  function started(n = 7, settings = {}) {
    const h = new Harness(settings);
    h.join(n);
    h.start();
    h.toPlay();
    return h;
  }

  it('starts a round with a category and a server deadline', () => {
    const h = started();
    expect(h.state.phase).toBe('round');
    expect(h.state.round).toBe(1);
    expect(h.state.categoryId).toBe('big');
    expect(h.state.deadline - h.state.startedAt).toBe(10000);
    expect(h.state.wakeAt).toBe(h.state.deadline + TEST_SETTINGS.graceMs);
    const view = phaseView(h.state, h.bank);
    expect(view.cat?.prompt).toBe('Name a big');
    expect(view.deadline).toBe(h.state.deadline);
  });

  it('does not reveal the category during the countdown', () => {
    const h = new Harness();
    h.join(7);
    h.start();
    expect(phaseView(h.state, h.bank).cat).toBeUndefined();
  });

  it('accepts, rejects as taken, rejects as invalid, and reports already-answered', () => {
    const h = started();
    expect(h.submit('p0', 'w1')).toMatchObject({ status: 'ok', answer: 'w1', rare: false, hearts: 2 });
    expect(h.submit('p1', ' W1 ')).toMatchObject({ status: 'taken', answer: 'w1', by: 'N-p0' });
    expect(h.submit('p1', 'zzz')).toMatchObject({ status: 'invalid' });
    expect(h.submit('p1', '')).toMatchObject({ status: 'invalid' });
    expect(h.submit('p0', 'w2')).toMatchObject({ status: 'already', answer: 'w1' });
    expect(h.state.claimed.has(2)).toBe(false);
    expect(h.submit('p1', 'w2')).toMatchObject({ status: 'ok', answer: 'w2' });
    expect(h.state.answered).toBe(2);
    expect(meView(h.state, h.bank, 'p0')?.answer).toBe('w1');
  });

  it('gives a simultaneous claim to whichever submission the server handles first', () => {
    const h = started();
    const t = h.t + 500;
    expect(h.submit('p3', 'w5', t).status).toBe('ok');
    expect(h.submit('p2', 'w5', t)).toMatchObject({ status: 'taken', by: 'N-p3' });
    expect(h.state.claimed.get(5)).toBe('p3');
  });

  it('awards a heart for a rare answer, up to the cap', () => {
    const h = started();
    expect(h.submit('p0', 'w9')).toMatchObject({ status: 'ok', rare: true, hearts: 3 });
    h.answerAll(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    h.pop();
    h.toPlay();
    expect(h.submit('p0', 'w19')).toMatchObject({ status: 'ok', rare: true, hearts: 3 });
    expect(h.p('p0').rares).toBe(2);
  });

  it('respects a custom rarity threshold', () => {
    const h = started(7, { rareThreshold: 0.2 });
    expect(h.submit('p0', 'w1')).toMatchObject({ status: 'ok', rare: true, hearts: 3 });
  });

  it('pops: players without an accepted answer lose a heart, at zero they are out', () => {
    const h = started();
    h.answerAll(['p0', 'p1', 'p2', 'p3']);
    const fx = h.pop();
    expect(h.state.phase).toBe('reveal');
    expect(['p0', 'p1', 'p2', 'p3'].every((id) => h.p(id).hearts === 2)).toBe(true);
    expect(['p4', 'p5', 'p6'].every((id) => h.p(id).hearts === 1 && h.p(id).status === 'alive')).toBe(true);
    expect(h.state.lastPop).toMatchObject({ lost: 3, out: 0, saved: false, aliveAfter: 7 });
    expect(fx.filter((e) => e.type === 'me').map((e) => (e as { pid: string }).pid)).toEqual(['p4', 'p5', 'p6']);

    h.toPlay();
    expect(h.state.round).toBe(2);
    expect(h.p('p0').answer).toBe(-1);
    h.answerAll(['p0', 'p1', 'p2', 'p3']);
    h.pop();
    expect(['p4', 'p5', 'p6'].every((id) => h.p(id).status === 'out' && h.p(id).hearts === 0)).toBe(true);
    // Eliminated in the same round: they share a place.
    expect(['p4', 'p5', 'p6'].map((id) => h.p(id).place)).toEqual([5, 5, 5]);
    expect(h.state.alive).toBe(4);
    expect(h.state.lastPop).toMatchObject({ lost: 3, out: 3, aliveAfter: 4 });
    expect(h.state.lastPop!.outNames.sort()).toEqual(['N-p4', 'N-p5', 'N-p6']);
    h.toPlay();
    expect(h.submit('p4', 'w100').status).toBe('out');
  });

  it('accepts submissions inside the grace window and closes after it', () => {
    const h = started();
    const d = h.state.deadline;
    h.send({ type: 'tick', t: d });
    expect(h.state.phase).toBe('round');
    expect(h.submit('p0', 'w1', d + TEST_SETTINGS.graceMs).status).toBe('ok');
    expect(h.submit('p1', 'w2', d + TEST_SETTINGS.graceMs + 1).status).toBe('closed');
    h.send({ type: 'tick', t: d + TEST_SETTINGS.graceMs });
    expect(h.state.phase).toBe('reveal');
    expect(h.p('p0').hearts).toBe(2);
    expect(h.p('p1').hearts).toBe(1);
    expect(h.state.stats.closest).toMatchObject({ by: 'N-p0', ms: -TEST_SETTINGS.graceMs });
    expect(h.submit('p2', 'w3').status).toBe('closed');
  });

  it('shortens the fuse every round down to the floor', () => {
    expect(roundFuse(TEST_SETTINGS, 1, 0)).toBe(10000);
    expect(roundFuse(TEST_SETTINGS, 2, 0)).toBe(9000);
    expect(roundFuse(TEST_SETTINGS, 3, 0)).toBe(8100);
    expect(roundFuse(TEST_SETTINGS, 30, 0)).toBe(TEST_SETTINGS.fuseMinMs);
  });

  it('stall safeguard: a round where almost nobody loses a heart makes the next one harder', () => {
    const h = started(7);
    h.answerAll(h.alive());
    h.pop();
    expect(h.state.pressure).toBe(1);
    h.toPlay();
    expect(h.state.deadline - h.state.startedAt).toBe(Math.round(9000 * TEST_SETTINGS.pressureFuseFactor));

    // A round with real losses does not add pressure.
    h.answerAll(['p0', 'p1', 'p2', 'p3']);
    h.pop();
    expect(h.state.pressure).toBe(1);
  });

  it('relief: a round where most players lose a heart eases the next fuse, within limits', () => {
    const h = started(7, { reliefFraction: 0.5 });
    h.answerAll(['p0', 'p1']);
    h.pop(); // 5 of 7 lost a heart
    expect(h.state.pressure).toBe(-1);
    h.toPlay();
    expect(h.state.deadline - h.state.startedAt).toBe(Math.round(9000 / TEST_SETTINGS.pressureFuseFactor));
    expect(roundFuse(TEST_SETTINGS, 1, -50)).toBe(MAX_FUSE_MS);
    for (let i = 0; i < 6 && h.state.phase === 'round'; i++) {
      h.answerAll(h.alive().slice(0, 1));
      h.pop();
      h.toPlay();
    }
    expect(h.state.pressure).toBeGreaterThanOrEqual(MIN_PRESSURE);
  });

  it('pressure can push the fuse below the normal floor, but not below the absolute floor', () => {
    const s = { ...TEST_SETTINGS, fuseMinMs: 6000 };
    expect(roundFuse(s, 30, 0)).toBe(6000);
    expect(roundFuse(s, 30, 1)).toBe(4800);
    expect(roundFuse(s, 30, 5)).toBe(ABSOLUTE_MIN_FUSE_MS);
  });

  it('wipeout safeguard: a pop that would eliminate everyone eliminates nobody', () => {
    const h = started(5);
    h.pop(); // nobody answers: everyone drops to 1 heart, which is not a wipeout
    expect(h.state.lastPop).toMatchObject({ lost: 5, out: 0, saved: false });
    expect(h.alive().length).toBe(5);
    h.toPlay();
    h.pop(); // would eliminate all five
    expect(h.state.lastPop).toMatchObject({ lost: 0, out: 0, saved: true, aliveAfter: 5 });
    expect(h.alive().length).toBe(5);
    expect(h.alive().every((id) => h.p(id).hearts === 1)).toBe(true);
    expect(h.state.phase).toBe('reveal');
  });

  it('wipeout safeguard does not apply when at least one player survives', () => {
    const h = started(5);
    h.pop();
    h.toPlay();
    h.answerAll(['p2']);
    h.pop();
    expect(h.state.phase).toBe('ended');
    expect(h.state.winner).toBe('p2');
    expect(h.p('p2').place).toBe(1);
    expect(['p0', 'p1', 'p3', 'p4'].map((id) => h.p(id).place)).toEqual([2, 2, 2, 2]);
  });

  it('ends by tie-break after three wipeout saves in a row', () => {
    const h = started(5);
    // Not a wipeout: p3 answered in round 1, so in round 2 they survive on their second heart.
    h.submit('p3', 'w1');
    h.pop();
    h.toPlay();
    h.pop();
    expect(h.state.phase).toBe('ended');
    expect(h.state.winner).toBe('p3');

    // A true stalemate: nobody ever answers.
    const g = started(5);
    g.pop();
    for (let i = 0; i < 3; i++) {
      expect(g.state.phase).toBe('reveal');
      g.toPlay();
      g.pop();
    }
    expect(g.state.saves).toBe(3);
    expect(g.state.phase).toBe('ended');
    expect(g.state.winner).toBe('p0'); // equal records: earliest seat wins the tie-break
    expect(g.alive()).toEqual(['p0']);
  });

  it('always terminates: a game where everyone always answers is ended by the round cap', () => {
    const h = started(5);
    for (let i = 0; i < MAX_MAIN_ROUNDS + 5 && h.state.phase !== 'ended'; i++) {
      h.answerAll(h.alive());
      h.pop();
      h.toPlay();
    }
    expect(h.state.phase).toBe('ended');
    expect(h.state.round).toBe(MAX_MAIN_ROUNDS);
    expect(h.state.winner).toBe('p0');
  });

  it('disconnected players still lose hearts, and reconnecting restores their seat', () => {
    const h = started(7);
    h.send({ type: 'leave', t: h.t, pid: 'p6' });
    expect(h.p('p6')).toMatchObject({ connected: false, status: 'alive', hearts: 2 });
    h.answerAll(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    h.pop();
    expect(h.p('p6').hearts).toBe(1);
    h.send({ type: 'connection', t: h.t, pid: 'p6', connected: true });
    expect(h.p('p6')).toMatchObject({ connected: true, status: 'alive', hearts: 1 });
    h.toPlay();
    expect(h.submit('p6', 'w500').status).toBe('ok');
  });
});

describe('category selection', () => {
  const bank = buildBank([
    makeCategory('big', 2000, 'a'),
    makeCategory('mid', 300, 'a'),
    makeCategory('small', 60, 'b'),
    makeCategory('tiny', 12, 'b'),
  ]);
  const picks = (need: number, patch: Partial<ReturnType<typeof createGame>> = {}, packs: string[] = []) => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const state = { ...createGame(seed, { ...TEST_SETTINGS, packs }), ...patch };
      seen.add(pickCategory(state, bank, need).id);
    }
    return [...seen].sort();
  };

  it('only picks categories with at least 3x as many answers as alive players', () => {
    expect(picks(400)).toEqual(['big']);
    expect(picks(100)).toEqual(['big', 'mid']);
    expect(picks(20)).toEqual(['big', 'mid', 'small']);
    expect(picks(4)).toEqual(['big', 'mid', 'small', 'tiny']);
  });

  it('never repeats a category within a game while unused ones remain', () => {
    expect(picks(4, { usedCategories: ['big', 'mid'] })).toEqual(['small', 'tiny']);
  });

  it('falls back to the largest unused category when none is big enough', () => {
    expect(picks(400, { usedCategories: ['big'] })).toEqual(['mid']);
  });

  it('reuses categories once all are used, but not the one just played', () => {
    expect(picks(4, { usedCategories: ['big', 'mid', 'small', 'tiny'] })).toEqual(['big', 'mid', 'small']);
  });

  it('honours the selected packs and ignores unknown ones', () => {
    expect(picks(400, {}, ['b'])).toEqual(['small']);
    expect(picks(4, {}, ['b'])).toEqual(['small', 'tiny']);
    expect(picks(400, {}, ['nope'])).toEqual(['big']);
  });

  it('uses a different category every round of a real game', () => {
    const h = new Harness({ finaleSize: 2 }, bank);
    h.join(4);
    h.start();
    for (let i = 0; i < 4; i++) {
      h.toPlay();
      h.answerAll(h.alive());
      h.pop();
    }
    expect(new Set(h.state.usedCategories).size).toBe(4);
  });
});

describe('finale', () => {
  function finale(settings = {}, bank = buildBank([makeCategory('big', 2000), makeCategory('big2', 2000)])) {
    const h = new Harness(settings, bank);
    h.join(3);
    h.start();
    return h;
  }

  it('begins when alive players drop to the finale size', () => {
    const h = new Harness();
    h.join(5);
    h.start();
    h.toPlay();
    for (let i = 0; i < 2; i++) {
      expect(h.state.phase).toBe('round');
      expect(h.state.finale).toBeNull();
      h.answerAll(['p0', 'p1', 'p2']);
      h.pop();
      if (i === 0) h.toPlay();
    }
    expect(h.state.alive).toBe(3);
    expect(h.p('p3').place).toBe(4);
    expect(h.state.phase).toBe('reveal');
    h.step();
    expect(h.state.phase).toBe('countdown');
    expect(h.state.finale?.order.slice().sort()).toEqual(['p0', 'p1', 'p2']);
    const view = phaseView(h.state, h.bank);
    expect(view.finale).toBe(true);
    expect(view.fin?.players.length).toBe(3);
    h.step();
    expect(h.state.phase).toBe('finale');
    expect(h.state.deadline - h.state.startedAt).toBe(5000);
  });

  it('starts directly in the finale when the room is small enough', () => {
    const h = finale();
    expect(h.state.finale).not.toBeNull();
    expect(h.state.phase).toBe('countdown');
  });

  it('only the holder may answer; an accepted answer passes the puffer', () => {
    const h = finale();
    h.toPlay();
    const order = h.state.finale!.order;
    expect(h.holder()).toBe(order[0]);
    expect(h.submit(order[1], 'w1').status).toBe('notturn');
    expect(h.state.claimed.size).toBe(0);
    expect(h.submit(order[0], 'w1')).toMatchObject({ status: 'ok', answer: 'w1' });
    expect(h.holder()).toBe(order[1]);
    expect(h.state.phase).toBe('finale');
    expect(h.state.finale).toMatchObject({ passes: 1, turns: 1, last: { answer: 'w1', by: `N-${order[0]}` } });
    expect(h.state.deadline - h.state.startedAt).toBe(4500); // personal fuse shrinks each turn
  });

  it('rejects answers already used in this category and keeps the turn', () => {
    const h = finale();
    h.toPlay();
    const order = h.state.finale!.order;
    h.submit(order[0], 'w1');
    expect(h.submit(order[1], 'w1')).toMatchObject({ status: 'taken', by: `N-${order[0]}` });
    expect(h.submit(order[1], 'nope')).toMatchObject({ status: 'invalid' });
    expect(h.holder()).toBe(order[1]);
    expect(h.submit(order[1], 'w2').status).toBe('ok');
    expect(h.holder()).toBe(order[2]);
    // The first holder can answer again later, but not with a used answer.
    h.submit(order[2], 'w3');
    expect(h.submit(order[0], 'w1').status).toBe('taken');
  });

  it('pops on the holder: they lose a heart and the puffer moves on', () => {
    const h = finale();
    h.toPlay();
    const order = h.state.finale!.order;
    h.pop();
    expect(h.p(order[0]).hearts).toBe(1);
    expect(h.p(order[1]).hearts).toBe(2);
    expect(h.state.phase).toBe('countdown');
    expect(h.state.lastPop).toMatchObject({ holder: `N-${order[0]}`, lost: 1, out: 0 });
    expect(h.holder()).toBe(order[1]);
    h.step();
    expect(h.state.phase).toBe('finale');
    expect(h.state.deadline - h.state.startedAt).toBe(4500);
  });

  it('still awards hearts for rare answers', () => {
    const h = finale();
    h.toPlay();
    expect(h.submit(h.holder(), 'w9')).toMatchObject({ status: 'ok', rare: true, hearts: 3 });
  });

  it('changes category after the configured number of passes', () => {
    const h = finale();
    h.toPlay();
    const first = h.state.categoryId;
    for (let i = 0; i < TEST_SETTINGS.finalePasses; i++) {
      expect(h.state.phase).toBe('finale');
      h.answerAll([h.holder()]);
    }
    expect(h.state.phase).toBe('countdown');
    expect(h.state.categoryId).not.toBe(first);
    expect(h.state.claimed.size).toBe(0);
    expect(h.state.finale!.passes).toBe(0);
    h.step();
    expect(h.state.phase).toBe('finale');
    expect(h.submit(h.holder(), 'w0').status).toBe('ok'); // usable again in the new category
  });

  it('changes category early when the current one is running dry', () => {
    const h = finale({}, buildBank([makeCategory('t1', 7), makeCategory('t2', 7)]));
    h.toPlay();
    const first = h.state.categoryId;
    h.answerAll([h.holder()]);
    expect(h.state.categoryId).toBe(first);
    h.answerAll([h.holder()]); // 5 left for 3 players: below 2x alive
    expect(h.state.categoryId).not.toBe(first);
    expect(h.state.phase).toBe('countdown');
  });

  it('eliminates the holder at zero hearts; the last player standing wins', () => {
    const h = finale();
    const order = [...h.state.finale!.order];
    for (let i = 0; i < 20 && h.state.phase !== 'ended'; i++) {
      h.toPlay();
      h.pop();
    }
    // Pops rotate: o0, o1, o2, o0 (out, 3rd), o1 (out, 2nd).
    expect(h.state.phase).toBe('ended');
    expect(h.p(order[0])).toMatchObject({ status: 'out', place: 3 });
    expect(h.p(order[1])).toMatchObject({ status: 'out', place: 2 });
    expect(h.p(order[2])).toMatchObject({ status: 'alive', place: 1, hearts: 1 });
    expect(h.state.winner).toBe(order[2]);
    expect(h.state.wakeAt).toBe(Infinity);
  });

  it('skips eliminated players when passing', () => {
    const h = finale({ startHearts: 1 });
    const order = [...h.state.finale!.order];
    h.toPlay();
    h.pop(); // order[0] is out
    h.toPlay();
    expect(h.holder()).toBe(order[1]);
    h.answerAll([order[1]]);
    expect(h.holder()).toBe(order[2]);
    h.answerAll([order[2]]);
    expect(h.holder()).toBe(order[1]);
  });

  it('has a fuse floor', () => {
    expect(finaleFuse(TEST_SETTINGS, 0)).toBe(5000);
    expect(finaleFuse(TEST_SETTINGS, 100)).toBe(TEST_SETTINGS.finaleFuseMinMs);
  });
});

describe('end of game', () => {
  function playedGame() {
    const h = new Harness();
    h.join(7);
    h.start();
    h.toPlay();
    h.submit('p0', 'w9'); // rare
    h.submit('p1', 'w1', h.state.deadline - 40); // closest call
    h.answerAll(['p2', 'p3']);
    h.pop();
    h.toPlay();
    h.answerAll(['p0', 'p1', 'p2']);
    h.pop(); // p4, p5, p6 out (place 4); p3 at 1 heart; 4 alive
    h.toPlay();
    h.answerAll(['p0', 'p1', 'p2']);
    h.pop(); // p3 out (place 4): 3 alive, finale next
    for (let i = 0; i < 30 && h.state.phase !== 'ended'; i++) {
      h.toPlay();
      if (h.state.phase === 'finale') h.pop();
    }
    return h;
  }

  it('reports the winner, standings in elimination order with shared places, and stats', () => {
    const h = playedGame();
    expect(h.state.phase).toBe('ended');
    const end = endView(h.state);
    expect(end.winner).toBe(h.p(h.state.winner!).name);
    expect(end.top.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(end.top[3].name).toBe('N-p3');
    expect(end.players).toBe(7);
    expect(end.rounds).toBe(3);
    expect(end.durationMs).toBeGreaterThan(0);
    expect(end.stats.rarest).toEqual({ answer: 'w9', by: 'N-p0' });
    expect(end.stats.closest).toMatchObject({ name: 'N-p1', ms: 40 });
    expect(end.stats.most?.claims).toBe(3);
    expect(phaseView(h.state, h.bank).end).toEqual(end);
    expect(meView(h.state, h.bank, 'p3')).toMatchObject({ status: 'out', place: 4, hearts: 0 });
  });

  it('place always equals the number of players who lasted longer, plus one', () => {
    const h = playedGame();
    const all = [...h.state.players.values()];
    for (const p of all) {
      expect(all.filter((q) => q.place < p.place).length).toBeLessThanOrEqual(p.place - 1);
      expect(p.place).toBeGreaterThan(0);
    }
    expect(all.filter((p) => p.place === 1).length).toBe(1);
  });

  it('play again returns everyone to the lobby and a new game starts clean', () => {
    const h = playedGame();
    const [late] = h.join(1, 'late');
    expect(h.p(late).status).toBe('waiting');
    h.send({ type: 'again', t: h.t });
    expect(h.state.phase).toBe('lobby');
    expect(h.state.players.size).toBe(8);
    expect([...h.state.players.values()].every((p) => p.status === 'lobby')).toBe(true);
    expect(h.state.settings).toEqual(TEST_SETTINGS);
    h.start();
    expect(h.state.gameNo).toBe(2);
    expect(h.state.alive).toBe(8);
    expect(h.state.usedCategories).toEqual([]);
    expect(h.state.finale).toBeNull();
    expect(h.state.winner).toBeNull();
    expect([...h.state.players.values()].every((p) => p.hearts === 2 && p.claims === 0 && p.place === 0)).toBe(true);
    h.toPlay();
    expect(h.submit(late, 'w1').status).toBe('ok');
  });

  it('ignores play-again unless the game has ended', () => {
    const h = new Harness();
    h.join(7);
    h.start();
    h.send({ type: 'again', t: h.t });
    expect(h.state.phase).toBe('countdown');
  });
});

describe('robustness', () => {
  it('is idempotent: a repeated sequence number returns the stored result and changes nothing', () => {
    const h = new Harness();
    h.join(7);
    h.start();
    h.toPlay();
    const first = h.send({ type: 'submit', t: h.t, pid: 'p0', seq: 1, text: 'w1' });
    const before = snapshot(h.state);
    const again = h.send({ type: 'submit', t: h.t + 5, pid: 'p0', seq: 1, text: 'w2' });
    expect(again).toEqual([first.find((e) => e.type === 'result')]);
    expect(snapshot(h.state)).toEqual(before);
    expect(h.p('p0').claims).toBe(1);
    // An older sequence number is dropped silently.
    h.send({ type: 'submit', t: h.t, pid: 'p0', seq: 2, text: 'zzz' });
    expect(h.send({ type: 'submit', t: h.t, pid: 'p0', seq: 1, text: 'w3' })).toEqual([]);
  });

  it('ignores events that make no sense in the current state', () => {
    const h = new Harness();
    expect(h.send({ type: 'submit', t: h.t, pid: 'ghost', seq: 1, text: 'w1' })).toEqual([]);
    expect(h.send({ type: 'tick', t: h.t + 99999 })).toEqual([]);
    expect(h.send({ type: 'again', t: h.t })).toEqual([]);
    expect(h.send({ type: 'leave', t: h.t, pid: 'ghost' })).toEqual([]);
    h.join(7);
    expect(h.submit('p0', 'w1').status).toBe('closed');
    h.start();
    const before = snapshot(h.state);
    h.start();
    expect(snapshot(h.state)).toEqual(before);
    expect(h.submit('p0', 'w1').status).toBe('closed'); // countdown
  });

  it('survives hostile answer text', () => {
    const h = new Harness();
    h.join(7);
    h.start();
    h.toPlay();
    for (const text of ['', ' ', '\u0000', '💥'.repeat(500), 'x'.repeat(100000), '__proto__', '<script>', '{"a":1}']) {
      expect(h.submit('p0', text).status).toBe('invalid');
    }
    expect(h.submit('p0', 'w1').status).toBe('ok');
  });

  it('logs every evaluated submission', () => {
    const h = new Harness();
    h.join(7);
    h.start();
    h.toPlay();
    h.effects.length = 0;
    h.submit('p0', 'W-1');
    h.submit('p1', 'w1');
    h.submit('p1', 'Not A Thing');
    expect(h.effects.filter((e) => e.type === 'log')).toEqual([
      { type: 'log', cat: 'big', round: 1, norm: 'w1', res: 'ok', ans: 'w1' },
      { type: 'log', cat: 'big', round: 1, norm: 'w1', res: 'taken', ans: 'w1' },
      { type: 'log', cat: 'big', round: 1, norm: 'notathing', res: 'invalid' },
    ]);
  });
});

describe('determinism', () => {
  function playRandomGame(seed: number, players = 40) {
    const bank = buildBank([
      makeCategory('a', 600),
      makeCategory('b', 500),
      makeCategory('c', 150),
      makeCategory('d', 40),
    ]);
    const h = new Harness({ finaleSize: 4 }, bank, seed);
    let r = seed >>> 0;
    const rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    h.join(players);
    h.start();
    for (let guard = 0; guard < 5000 && h.state.phase !== 'ended'; guard++) {
      h.toPlay();
      const size = h.bank.byId.get(h.state.categoryId!)!.size;
      if (h.state.phase === 'round') {
        for (const pid of h.alive()) {
          if (rnd() < 0.75) h.submit(pid, `w${Math.floor(rnd() * size)}`, h.state.startedAt + Math.floor(rnd() * 4000));
        }
        h.pop();
      } else if (h.state.phase === 'finale') {
        if (rnd() < 0.7) h.submit(h.holder(), `w${Math.floor(rnd() * size)}`);
        else h.pop();
      }
    }
    return h;
  }

  it('replays identically from the same seed and events', () => {
    const a = playRandomGame(42);
    const b = playRandomGame(42);
    expect(a.state.phase).toBe('ended');
    expect(snapshot(a.state)).toEqual(snapshot(b.state));
    expect(a.effects).toEqual(b.effects);
  });

  it('holds its invariants across many random games', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const h = playRandomGame(seed, 10 + seed * 3);
      const all = [...h.state.players.values()];
      expect(h.state.phase).toBe('ended');
      expect(all.filter((p) => p.status === 'alive').length).toBe(1);
      expect(all.filter((p) => p.place === 1).length).toBe(1);
      expect(all.every((p) => p.place >= 1 && p.hearts >= 0 && p.hearts <= TEST_SETTINGS.maxHearts)).toBe(true);
      expect(h.state.alive).toBe(1);
      for (const p of all) expect(all.filter((q) => q.place < p.place).length).toBe(p.place - 1);
    }
  });
});
