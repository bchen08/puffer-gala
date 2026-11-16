import type { Bank } from '../engine/matcher.ts';
import type { PackInfo } from '../shared/protocol.ts';
import type { Metrics } from './metrics.ts';
import { randomRoomCode, randomToken } from './names.ts';
import { Room, type LogEntry } from './room.ts';

const MAX_ROOMS = 500;
/** A room with no sockets is deleted after this long. */
const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000;
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function packInfo(bank: Bank): PackInfo[] {
  return bank.packs.map((id) => {
    const cats = bank.categories.filter((c) => c.pack === id);
    return { id, categories: cats.length, answers: cats.reduce((n, c) => n + c.size, 0) };
  });
}

/** All rooms in this process. Rooms are independent; they share only the read-only bank. */
export class Registry {
  readonly rooms = new Map<string, Room>();
  private bank: Bank;
  private packs: PackInfo[];
  private metrics?: Metrics;
  private log?: (entry: LogEntry) => void;

  constructor(bank: Bank, opts: { metrics?: Metrics; log?: (entry: LogEntry) => void } = {}) {
    this.bank = bank;
    this.packs = packInfo(bank);
    this.metrics = opts.metrics;
    this.log = opts.log;
  }

  create(now: number): Room | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    const room = new Room(code, randomToken(), now, {
      bank: this.bank,
      packs: this.packs,
      metrics: this.metrics,
      log: this.log,
      hrtime: () => performance.now(),
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  get connections(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.connections;
    return n;
  }

  advance(now: number): void {
    for (const room of this.rooms.values()) room.advance(now);
  }

  /** Deletes abandoned and very old rooms. */
  sweep(now: number): void {
    for (const [code, room] of this.rooms) {
      const abandoned = room.connections === 0 && now - room.lastActiveAt > EMPTY_ROOM_TTL_MS;
      if (abandoned || now - room.createdAt > ROOM_MAX_AGE_MS) {
        room.closeAll();
        this.rooms.delete(code);
      }
    }
  }
}
