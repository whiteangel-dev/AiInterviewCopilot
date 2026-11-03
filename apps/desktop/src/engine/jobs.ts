import { AppError, type JobProgress } from '@aic/ipc';

export interface JobContext {
  signal: AbortSignal;
  progress(stage: string, message: string): void;
}

/**
 * Long-running AI work. The caller picks the job ID so it can listen for
 * progress and cancel before the request returns.
 */
export class Jobs {
  readonly #running = new Map<string, AbortController>();

  constructor(private readonly onProgress: (p: JobProgress) => void) {}

  async run<T>(jobId: string, work: (ctx: JobContext) => Promise<T>): Promise<T> {
    if (this.#running.has(jobId))
      throw new AppError('invalid_input', 'That job is already running.');
    const controller = new AbortController();
    this.#running.set(jobId, controller);
    try {
      return await work({
        signal: controller.signal,
        progress: (stage, message) => this.onProgress({ jobId, stage, message }),
      });
    } catch (err) {
      if (controller.signal.aborted) throw new AppError('cancelled', 'Cancelled.');
      throw err;
    } finally {
      this.#running.delete(jobId);
    }
  }

  cancel(jobId: string): void {
    this.#running.get(jobId)?.abort();
  }

  get size(): number {
    return this.#running.size;
  }
}
