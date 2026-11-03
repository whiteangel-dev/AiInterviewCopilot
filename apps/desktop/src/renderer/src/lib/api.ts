import type {
  EventChannel,
  EventPayloads,
  InvokeChannel,
  InvokeInput,
  InvokeOutput,
  Result,
} from '@aic/ipc';
import { AppError } from '@aic/ipc/errors';

type InputArgs<C extends InvokeChannel> =
  undefined extends InvokeInput<C> ? [input?: InvokeInput<C>] : [input: InvokeInput<C>];

/** Typed call to the main process. Throws `AppError` with the original error code. */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...[input]: InputArgs<C>
): Promise<InvokeOutput<C>> {
  const result = (await window.aic.invoke(channel, input)) as Result<InvokeOutput<C>>;
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.data;
}

export function on<E extends EventChannel>(
  event: E,
  listener: (payload: EventPayloads[E]) => void,
): () => void {
  return window.aic.on(event, listener as (payload: unknown) => void);
}
