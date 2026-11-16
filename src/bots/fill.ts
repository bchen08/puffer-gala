/**
 * Fills an existing room with bots, for trying the UI without a crowd.
 *
 *   node src/bots/fill.ts --room <code> [--players 30] [--url http://localhost:8787]
 *
 * <code> is the four-letter code of a room you have already created in the browser
 * ("Host a new room" on the home page). The bots join, play every game the host starts,
 * and leave when you press Ctrl+C.
 */
import { loadBank } from '../server/loadBank.ts';
import { mulberry32 } from '../sim/behavior.ts';
import { Bot, Collector } from './bot.ts';

const USAGE = 'usage: npm run bots -- --room <4-letter code> [--players 30] [--url http://localhost:8787]';
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const room = opt('room', '').toUpperCase();
const requested = Number(opt('players', '30'));
const httpUrl = opt('url', 'http://localhost:8787').replace(/\/+$/, '');

if (!room) fail(`Which room? Create one in the browser first, then pass its code.\n${USAGE}`);
if (!/^[A-Z]{4}$/.test(room)) fail(`"${room}" is not a room code. Codes are four letters, for example RMHF.\n${USAGE}`);
if (!Number.isInteger(requested) || requested < 1 || requested > 500) fail(`--players must be a whole number from 1 to 500.\n${USAGE}`);

// Look the room up before opening any sockets, so mistakes get a plain answer.
let info: { phase: string; seats: number; maxPlayers: number };
try {
  const res = await fetch(`${httpUrl}/api/rooms/${room}`);
  if (res.status === 404) {
    fail(
      `There is no room ${room} on ${httpUrl}.\n` +
        `Open ${httpUrl} in a browser, choose "Host a new room", and use the code it shows.` +
        (room === 'CODE' ? '\n(CODE in the example is a placeholder for that code.)' : ''),
    );
  }
  if (!res.ok) fail(`The server at ${httpUrl} answered ${res.status} for room ${room}.`);
  info = (await res.json()) as typeof info;
} catch {
  fail(`No game server is answering at ${httpUrl}. Start it with "npm start" (or pass --url).`);
}

const free = info!.maxPlayers - info!.seats;
if (free <= 0) fail(`Room ${room} is full (${info!.seats} of ${info!.maxPlayers} seats). Raise "Max players" in the host settings.`);
const players = Math.min(requested, free);
if (players < requested) console.log(`Room ${room} has ${free} free seats, so only ${players} bots will join.`);

const NAMES = ['Mina', 'Jo', 'Tariq', 'Lena', 'Okoro', 'Sven', 'Priya', 'Bea', 'Koji', 'Ines', 'Dev', 'Zara', 'Milo', 'Aiko', 'Remy', 'Nia'];
const bank = loadBank();
const collector = new Collector();
const bots = Array.from(
  { length: players },
  (_, i) =>
    new Bot({
      wsUrl: httpUrl.replace(/^http/, 'ws'),
      room,
      name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ' ' + (Math.floor(i / NAMES.length) + 1) : ''}`,
      bank,
      rng: mulberry32(Date.now() + i),
      collector,
    }),
);

/** A bot that is refused (room filled up meanwhile, for example) never gets a welcome; don't wait forever. */
const seat = (bot: Bot) =>
  Promise.race([bot.connect(), new Promise<void>((resolve) => setTimeout(resolve, 5000))]).catch(() => {});
for (let i = 0; i < bots.length; i += 25) await Promise.all(bots.slice(i, i + 25).map(seat));

const seated = bots.filter((b) => b.me).length;
if (seated === 0) fail(`No bots could join room ${room}.${collector.errors[0] ? ` First error: ${collector.errors[0]}` : ''}`);
console.log(`${seated} bots seated in room ${room}. Press Ctrl+C to remove them.`);
if (seated < players) console.log(`${players - seated} could not join${collector.errors[0] ? ` (${collector.errors[0]})` : ''}.`);
if (info!.phase !== 'lobby') console.log('A game is already in progress there, so they will watch and play from the next game.');

process.on('SIGINT', () => {
  for (const b of bots) b.close();
  setTimeout(() => process.exit(0), 200);
});
