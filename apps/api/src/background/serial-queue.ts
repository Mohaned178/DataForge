/**
 * Work items processed one at a time, in the order they were enqueued, in this process. It holds
 * only the order of the work; what an item means and its status live elsewhere (the database), so a
 * stopped process loses nothing that recovery on the next start cannot find again.
 */
export class SerialQueue {
  private readonly queue: string[] = [];
  private active: Promise<void> | undefined;
  private stoppingNow = false;

  constructor(private readonly process: (id: string) => Promise<void>) {}

  /** True once stop() was called: no new work is taken. */
  get stopping(): boolean {
    return this.stoppingNow;
  }

  enqueue(id: string): void {
    if (this.stoppingNow || this.queue.includes(id)) {
      return;
    }
    this.queue.push(id);
    this.drain();
  }

  /** Resolves when the queue is empty and no item is being processed. */
  async whenIdle(): Promise<void> {
    while (this.active !== undefined) {
      await this.active;
    }
  }

  /** Takes no new work and waits for the item in progress; queued items stay where their status lives. */
  async stop(): Promise<void> {
    this.stoppingNow = true;
    this.queue.length = 0;
    await this.whenIdle();
  }

  private drain(): void {
    if (this.active !== undefined || this.stoppingNow) {
      return;
    }
    this.active = (async () => {
      let id = this.queue.shift();
      while (id !== undefined && !this.stoppingNow) {
        await this.process(id);
        id = this.queue.shift();
      }
    })().finally(() => {
      this.active = undefined;
      if (this.queue.length > 0) {
        this.drain();
      }
    });
  }
}
