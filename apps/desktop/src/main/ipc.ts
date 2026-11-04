import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { redact, type Logger } from '@aic/core';
import {
  AppError,
  INVOKE_CHANNELS,
  IPC_PREFIX,
  invokeContract,
  type EventChannel,
  type EventPayloads,
  type InvokeChannel,
  type InvokeOutputs,
  type Result,
} from '@aic/ipc';
import { z } from 'zod';

export type InvokeHandlers = {
  [C in InvokeChannel]: (
    input: z.output<(typeof invokeContract)[C]>,
  ) => InvokeOutputs[C] | Promise<InvokeOutputs[C]>;
};

/**
 * Registers every renderer → main channel. Each call is checked for a trusted
 * sender, validated against its zod schema, and answered with a `Result`
 * envelope so error codes survive Electron's IPC.
 */
export function registerInvokeHandlers(
  handlers: InvokeHandlers,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  log: Logger,
): void {
  for (const channel of INVOKE_CHANNELS) {
    const schema: z.ZodType = invokeContract[channel];
    const handler = handlers[channel] as (input: unknown) => unknown;

    ipcMain.handle(IPC_PREFIX + channel, async (event, raw: unknown): Promise<Result<unknown>> => {
      if (!isTrustedSender(event)) {
        log.warn('rejected IPC from untrusted sender', { channel });
        return { ok: false, error: { code: 'internal', message: 'Request rejected.' } };
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'invalid_input', message: z.prettifyError(parsed.error) },
        };
      }
      try {
        return { ok: true, data: await handler(parsed.data) };
      } catch (err) {
        const error = AppError.from(err);
        if (error.code === 'internal') log.error('IPC handler failed', { channel, err });
        else log.info('IPC handler returned an error', { channel, code: error.code });
        return { ok: false, error: { code: error.code, message: redact(error.message) } };
      }
    });
  }
}

/** Windows without the app bridge (the hidden capture window) get no events. */
const noBroadcast = new WeakSet<WebContents>();

export function excludeFromBroadcast(contents: WebContents): void {
  noBroadcast.add(contents);
}

export function broadcast<E extends EventChannel>(event: E, payload: EventPayloads[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || noBroadcast.has(win.webContents)) continue;
    win.webContents.send(IPC_PREFIX + event, payload);
  }
}
