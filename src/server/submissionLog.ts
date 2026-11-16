import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry } from './room.ts';

/**
 * Append-only JSONL log of every evaluated submission, one file per UTC day.
 * Entries are buffered in memory and flushed every two seconds, so logging never
 * delays a submission. Schema: see LogEntry and ARCHITECTURE.md section 4.
 */
export class SubmissionLog {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref();
  }

  write = (entry: LogEntry): void => {
    this.buffer.push(JSON.stringify(entry));
    // Bound memory if the disk stalls.
    if (this.buffer.length > 100_000) this.buffer.splice(0, 50_000);
  };

  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.writing;
    const lines = this.buffer.join('\n') + '\n';
    this.buffer = [];
    const file = join(this.dir, `submissions-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.writing = this.writing
      .then(() => mkdir(this.dir, { recursive: true }))
      .then(() => appendFile(file, lines))
      .catch((err) => console.error('submission log write failed:', err.message));
    return this.writing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
