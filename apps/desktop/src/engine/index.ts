/**
 * Engine entry point, started by the main process with `utilityProcess.fork`.
 * Talks to main over `process.parentPort` using the typed RPC in @aic/ipc.
 */
import { serveRpc, type EngineEvents, type EngineMethods, type RpcEndpoint } from '@aic/ipc';
import { createEngine } from './engine';

const parentPort = process.parentPort;

const endpoint: RpcEndpoint = {
  postMessage: (message) => parentPort.postMessage(message),
  onMessage: (listener) => {
    const handler = (event: Electron.MessageEvent) => listener(event.data);
    parentPort.on('message', handler);
    return () => parentPort.off('message', handler);
  },
};

const engine = createEngine({
  // `server` is assigned below, before any request (and so any event) can arrive.
  emit: (event, data) => server.emit(event, data),
  exit: (code) => process.exit(code),
  // Set by main when unpackaged, so engine logs show in the dev terminal.
  logToConsole: process.env.AIC_ENGINE_CONSOLE === '1',
});

const server = serveRpc<EngineMethods, EngineEvents>(endpoint, engine.handlers, {
  onError: (method, error) => engine.logger().warn('request failed', { method, err: error }),
});

process.on('uncaughtException', (err) => {
  engine.logger().error('uncaught exception', { err });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  engine.logger().error('unhandled rejection', { err: reason });
});
