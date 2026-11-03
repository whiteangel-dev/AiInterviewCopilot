import type { InvokeChannel, InvokeInput, InvokeOutput } from '@aic/ipc';
import { AppError } from '@aic/ipc/errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, on } from '../lib/api';

type JobChannel = {
  [C in InvokeChannel]: InvokeInput<C> extends { jobId: string } ? C : never;
}[InvokeChannel];

export interface JobState {
  running: boolean;
  /** Latest progress message from the engine. */
  message: string | null;
  startedAt: number | null;
}

/**
 * Runs a long AI job (resume analysis, answer generation, …) with progress
 * messages and cancel. Resolves to null if the user cancelled.
 */
export function useJob<C extends JobChannel>(channel: C) {
  const [state, setState] = useState<JobState>({ running: false, message: null, startedAt: null });
  const jobId = useRef<string | null>(null);

  useEffect(
    () =>
      on('job:progress', (p) => {
        if (p.jobId === jobId.current) setState((s) => ({ ...s, message: p.message }));
      }),
    [],
  );

  // Cancel a job still running when the component goes away.
  useEffect(
    () => () => {
      if (jobId.current)
        void invoke('jobs:cancel', { jobId: jobId.current }).catch(() => undefined);
    },
    [],
  );

  const run = useCallback(
    async (input: Omit<InvokeInput<C>, 'jobId'>): Promise<InvokeOutput<C> | null> => {
      const id = crypto.randomUUID();
      jobId.current = id;
      setState({ running: true, message: 'Starting…', startedAt: Date.now() });
      try {
        const run = invoke as (c: InvokeChannel, i: unknown) => Promise<InvokeOutput<C>>;
        return await run(channel, { ...input, jobId: id });
      } catch (err) {
        if (err instanceof AppError && err.code === 'cancelled') return null;
        throw err;
      } finally {
        if (jobId.current === id) jobId.current = null;
        setState({ running: false, message: null, startedAt: null });
      }
    },
    [channel],
  );

  const cancel = useCallback(() => {
    if (jobId.current) void invoke('jobs:cancel', { jobId: jobId.current });
  }, []);

  return { ...state, run, cancel };
}
