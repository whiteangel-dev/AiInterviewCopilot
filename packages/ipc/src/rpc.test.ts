import { describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import { RpcClient, createEndpointPair, serveRpc } from './rpc';

type Methods = {
  add: { params: { a: number; b: number }; result: number };
  fail: { params: void; result: never };
  hang: { params: void; result: void };
};
type Events = { tick: number };

function setup() {
  const [clientEnd, serverEnd] = createEndpointPair();
  const server = serveRpc<Methods, Events>(serverEnd, {
    add: ({ a, b }) => a + b,
    fail: () => {
      throw new AppError('invalid_api_key', 'nope');
    },
    hang: () => new Promise<void>(() => {}),
  });
  const client = new RpcClient<Methods, Events>(clientEnd, { timeoutMs: 200 });
  return { client, server };
}

describe('rpc', () => {
  it('round-trips results', async () => {
    const { client } = setup();
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('preserves error codes', async () => {
    const { client } = setup();
    await expect(client.call('fail')).rejects.toMatchObject({
      code: 'invalid_api_key',
      message: 'nope',
    });
  });

  it('rejects unknown methods, including prototype names', async () => {
    const { client } = setup();
    const raw = client as unknown as RpcClient<Record<string, { params: void; result: unknown }>>;
    await expect(raw.call('toString')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('times out', async () => {
    const { client } = setup();
    await expect(client.call('hang', undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(client.pendingCount).toBe(0);
  });

  it('close() rejects pending calls', async () => {
    const { client } = setup();
    const pending = client.call('hang');
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(client.call('add', { a: 1, b: 1 })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
  });

  it('delivers events', async () => {
    const { client, server } = setup();
    const listener = vi.fn();
    const off = client.on('tick', listener);
    server.emit('tick', 1);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
    off();
    server.emit('tick', 2);
    await new Promise((r) => setTimeout(r, 5));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
