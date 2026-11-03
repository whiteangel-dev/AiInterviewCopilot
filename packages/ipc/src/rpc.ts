import { AppError, type SerializedError } from './errors';

/**
 * A minimal typed request/response + event protocol over any message channel:
 * a utilityProcess parent port, a MessagePort, or an in-memory pair in tests.
 * Structured-clone payloads only; errors travel as `SerializedError`.
 */
export interface RpcEndpoint {
  postMessage(message: unknown): void;
  /** Subscribes to incoming messages; returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
}

export type MethodMap = Record<string, { params: unknown; result: unknown }>;
export type EventMap = Record<string, unknown>;

export interface CallOptions {
  /** 0 disables the timeout. */
  timeoutMs?: number;
}

type RequestMessage = { kind: 'request'; id: number; method: string; params: unknown };
type ResponseMessage =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: SerializedError };
type EventMessage = { kind: 'event'; event: string; data: unknown };

type CallArgs<P> = [P] extends [void]
  ? [params?: undefined, options?: CallOptions]
  : [params: P, options?: CallOptions];

export type RpcHandlers<M extends MethodMap> = {
  [K in keyof M]: (params: M[K]['params']) => M[K]['result'] | Promise<M[K]['result']>;
};

interface Pending {
  resolve(value: unknown): void;
  reject(reason: AppError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class RpcClient<M extends MethodMap, E extends EventMap = Record<never, never>> {
  readonly #endpoint: RpcEndpoint;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(data: never) => void>>();
  readonly #unsubscribe: () => void;
  #nextId = 1;
  #closedWith: AppError | null = null;

  constructor(endpoint: RpcEndpoint, options: { timeoutMs?: number } = {}) {
    this.#endpoint = endpoint;
    this.#defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#unsubscribe = endpoint.onMessage((message) => this.#handle(message));
  }

  call<K extends keyof M & string>(
    method: K,
    ...[params, options]: CallArgs<M[K]['params']>
  ): Promise<M[K]['result']> {
    if (this.#closedWith) return Promise.reject(this.#closedWith);
    const id = this.#nextId++;
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;
    return new Promise<M[K]['result']>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(
                new AppError('timeout', `"${method}" did not respond within ${timeoutMs} ms.`),
              );
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      try {
        const request: RequestMessage = { kind: 'request', id, method, params };
        this.#endpoint.postMessage(request);
      } catch (err) {
        this.#settle(id)?.reject(AppError.from(err));
      }
    });
  }

  on<K extends keyof E & string>(event: K, listener: (data: E[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Rejects every pending call and ignores further messages. */
  close(reason = new AppError('engine_unavailable', 'The connection was closed.')): void {
    if (this.#closedWith) return;
    this.#closedWith = reason;
    this.#unsubscribe();
    for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(reason);
    this.#listeners.clear();
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #settle(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  #handle(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.kind === 'response' && typeof message.id === 'number') {
      const response = message as ResponseMessage;
      const pending = this.#settle(response.id);
      if (!pending) return; // timed out or closed
      if (response.ok) pending.resolve(response.result);
      else pending.reject(AppError.from(response.error));
    } else if (message.kind === 'event' && typeof message.event === 'string') {
      const event = message as EventMessage;
      for (const listener of this.#listeners.get(event.event) ?? []) {
        try {
          (listener as (data: unknown) => void)(event.data);
        } catch (err) {
          console.error(`RPC event listener for "${event.event}" threw`, err);
        }
      }
    }
  }
}

export interface RpcServer<E extends EventMap> {
  emit<K extends keyof E & string>(event: K, data: E[K]): void;
  close(): void;
}

export function serveRpc<M extends MethodMap, E extends EventMap = Record<never, never>>(
  endpoint: RpcEndpoint,
  handlers: RpcHandlers<M>,
  options: { onError?: (method: string, error: unknown) => void } = {},
): RpcServer<E> {
  const respond = (response: ResponseMessage) => {
    try {
      endpoint.postMessage(response);
    } catch (err) {
      options.onError?.('(respond)', err);
    }
  };

  const handle = async (request: RequestMessage) => {
    const handler = Object.hasOwn(handlers, request.method)
      ? (handlers[request.method] as (params: unknown) => unknown)
      : undefined;
    if (!handler) {
      respond({
        kind: 'response',
        id: request.id,
        ok: false,
        error: { code: 'invalid_input', message: `Unknown method "${request.method}".` },
      });
      return;
    }
    try {
      const result = await handler(request.params);
      respond({ kind: 'response', id: request.id, ok: true, result });
    } catch (err) {
      options.onError?.(request.method, err);
      respond({ kind: 'response', id: request.id, ok: false, error: AppError.from(err).toJSON() });
    }
  };

  const unsubscribe = endpoint.onMessage((message) => {
    if (
      isRecord(message) &&
      message.kind === 'request' &&
      typeof message.id === 'number' &&
      typeof message.method === 'string'
    ) {
      void handle(message as RequestMessage);
    }
  });

  return {
    emit(event, data) {
      const message: EventMessage = { kind: 'event', event, data };
      endpoint.postMessage(message);
    },
    close: unsubscribe,
  };
}

/** Two connected in-memory endpoints (asynchronous delivery, structured clone), for tests. */
export function createEndpointPair(): [RpcEndpoint, RpcEndpoint] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const make = (self: 0 | 1): RpcEndpoint => ({
    postMessage(message) {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[self === 0 ? 1 : 0]) listener(copy);
      });
    },
    onMessage(listener) {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
  });
  return [make(0), make(1)];
}
