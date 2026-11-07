/** Injectable time source so adapters are deterministic in tests. Owner: Person 5. */
export interface Timers {
  /** Browser monotonic milliseconds (performance.now()). */
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/** Test/demo timers: time moves only through advance(). */
export class ManualTimers implements Timers {
  private t: number;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();

  constructor(startMs = 1000) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.t + Math.max(0, ms), fn, every: null });
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.t + Math.max(1, ms), fn, every: Math.max(1, ms) });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  clearInterval(id: number): void {
    this.tasks.delete(id);
  }

  /** Advance time, running due tasks in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.at <= end && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const task = this.tasks.get(nextId)!;
      this.t = Math.max(this.t, task.at);
      if (task.every !== null) task.at += task.every;
      else this.tasks.delete(nextId);
      task.fn();
    }
    this.t = end;
  }
}
