// The newest surface frame, and the waiters that want the next one.
//
// The host holds one frame request open per viewer
// (`GET /surface/frame?after=<seq>&wait=<ms>`: the next frame newer than `seq`,
// or 204). Chrome's screencast pushes a frame whenever the picture changes, so
// this is the buffer between the push and the pull: only the newest frame is
// kept, a waiter is woken by the first frame newer than the sequence it asked
// for, and a slow viewer skips frames instead of queueing them — the host's
// one-frame-in-flight rule is the backpressure, this is the store behind it.
//
// The sequence number is MONOTONIC for the life of the store and never resets,
// not even when the picture goes away: a viewer's request says "give me
// something newer than 57", and a counter that restarted at 1 would answer
// 204 forever. Sequence numbers start at 1, so `after=0` is "the picture, now".

/** A picture of the whole viewport, in the coordinate space the panel maps into. */
export type SurfaceFrame = {
  /** JPEG bytes of the viewport. */
  jpeg: Buffer;
  /** Service-side sequence number: monotonic, starts at 1, never repeats. */
  seq: number;
  /** The picture's coordinate space, in viewport CSS pixels. */
  width: number;
  height: number;
};

type Waiter = {
  /** The sequence the waiter already has; it wants something newer. */
  after: number;
  resolve: (frame: SurfaceFrame | null) => void;
  timer: NodeJS.Timeout;
};

export class FrameStore {
  private frame: SurfaceFrame | null = null;
  private seq = 0;
  private readonly waiters = new Set<Waiter>();

  /** The newest frame, or null before the first one arrived (or after `close`). */
  latest(): SurfaceFrame | null {
    return this.frame;
  }

  /** Keep a frame from the browser and wake every waiter that wants it. */
  push(jpeg: Buffer, width: number, height: number): SurfaceFrame {
    this.seq += 1;
    const frame: SurfaceFrame = { jpeg, seq: this.seq, width, height };
    this.frame = frame;
    for (const waiter of [...this.waiters]) {
      if (frame.seq > waiter.after) this.settle(waiter, frame);
    }
    return frame;
  }

  /**
   * The next frame newer than `after`, or null once `waitMs` has passed. A frame
   * that is already newer resolves at once — the host's first request is
   * `after=0`, which is "the picture, now" — and a non-positive wait never
   * registers a waiter at all.
   */
  next(after: number, waitMs: number): Promise<SurfaceFrame | null> {
    const current = this.frame;
    if (current && current.seq > after) return Promise.resolve(current);
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { after, resolve, timer: setTimeout(() => this.settle(waiter, null), waitMs) };
      this.waiters.add(waiter);
    });
  }

  /**
   * Drop the picture and release every waiter with null. The sequence counter is
   * deliberately kept: a viewer that has already drawn frame 57 must be able to
   * ask for something newer after the browser comes back.
   */
  close(): void {
    for (const waiter of [...this.waiters]) this.settle(waiter, null);
    this.frame = null;
  }

  private settle(waiter: Waiter, frame: SurfaceFrame | null): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }
}
