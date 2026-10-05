import type { LogLine } from "./types";

const LOG_FLUSH_MS = 75; // coalesce a burst of child output into one batched emit
const MAX_PENDING_LOGS = 2000; // cap the live batch — under a flood, shed oldest

/**
 * Live-log backpressure. Child output is queued and flushed in coalesced batches so
 * a noisy process can't fan out one SSE write per line to every connected client.
 * Under a sustained flood the buffer sheds its oldest line (the per-process REST ring
 * still keeps the full history); a single armed timer batches everything in its window.
 *
 * `pending` is a fixed-capacity ring (head + count), not a plain array: shedding the
 * oldest line under flood used to be an `Array.shift()` per push — an O(n) copy of
 * every remaining element, per line, once the cap is hit. The ring drops the oldest
 * slot in O(1) by just advancing `head` and letting the write wrap around.
 */
export class LogBuffer {
  private ring: (LogLine | undefined)[] = new Array(MAX_PENDING_LOGS);
  private head = 0; // index of the oldest queued line
  private count = 0; // number of queued lines (<= MAX_PENDING_LOGS)
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onFlush: (batch: LogLine[]) => void) {}

  /** Queue a line; arm a single flush timer that subsequent lines ride along with. */
  push(line: LogLine): void {
    this.pushMany([line]);
  }

  /** Queue a whole child-output chunk without repeating timer/bookkeeping work per line. */
  pushMany(lines: readonly LogLine[]): void {
    for (const line of lines) {
      const tail = (this.head + this.count) % MAX_PENDING_LOGS;
      this.ring[tail] = line;
      if (this.count < MAX_PENDING_LOGS) this.count++;
      else this.head = (this.head + 1) % MAX_PENDING_LOGS; // overwrote the oldest slot — shed it
    }
    if (!lines.length) return;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), LOG_FLUSH_MS);
  }

  /** Emit the buffered lines as ONE batch, oldest first. The GUI fans them out to each process. */
  private flush(): void {
    this.timer = null;
    if (!this.count) return;
    const batch: LogLine[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) batch[i] = this.ring[(this.head + i) % MAX_PENDING_LOGS]!;
    this.head = 0;
    this.count = 0;
    this.onFlush(batch);
  }
}
