import { monitorEventLoopDelay } from 'node:perf_hooks';

const MAX_SAMPLES = 200_000;

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Process-wide counters for the load test and for a quick health look in production. */
export class Metrics {
  msgsOut = 0;
  bytesOut = 0;
  msgsIn = 0;
  bytesIn = 0;
  submits = 0;
  badFrames = 0;
  droppedTicks = 0;
  kicked = 0;
  private submitMs = new Float64Array(MAX_SAMPLES);
  private submitCount = 0;
  private loop: ReturnType<typeof monitorEventLoopDelay>;
  private startedAt = Date.now();

  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
  }

  /** Counts one message written to `sockets` sockets. */
  out(data: string, sockets: number): void {
    this.msgsOut += sockets;
    this.bytesOut += Buffer.byteLength(data) * sockets;
  }

  /** Records how long the server took to handle one submission, receive to send. */
  observeSubmit(ms: number): void {
    this.submitMs[this.submitCount % MAX_SAMPLES] = ms;
    this.submitCount++;
    this.submits++;
  }

  snapshot(extra: { rooms: number; connections: number }) {
    const n = Math.min(this.submitCount, MAX_SAMPLES);
    const sorted = this.submitMs.slice(0, n).sort();
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    return {
      now: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      ...extra,
      msgsOut: this.msgsOut,
      bytesOut: this.bytesOut,
      msgsIn: this.msgsIn,
      bytesIn: this.bytesIn,
      submits: this.submits,
      badFrames: this.badFrames,
      droppedTicks: this.droppedTicks,
      kicked: this.kicked,
      submitMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: n ? sorted[n - 1] : 0,
      },
      // The histogram reports nanoseconds, and includes the 10 ms sampling resolution itself.
      loopDelayMs: {
        p50: this.loop.percentile(50) / 1e6,
        p99: this.loop.percentile(99) / 1e6,
        max: this.loop.max / 1e6,
      },
      cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      memMb: { rss: mem.rss / 1048576, heapUsed: mem.heapUsed / 1048576 },
    };
  }
}

export type StatsSnapshot = ReturnType<Metrics['snapshot']>;
