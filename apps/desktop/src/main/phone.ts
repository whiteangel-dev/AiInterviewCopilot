import type { Logger } from '@aic/core';
import type { PhoneStatus } from '@aic/ipc';
import type { EngineHost } from './engine-host';
import { PhoneServer, newPhoneToken } from './phone-server';
import type { SecretStore } from './secret-store';

const TOKEN_REF = 'phone.token';

/**
 * Turns the phone screen on and off with the setting, keeps the pairing token
 * (in the OS-protected secret store, so phones stay paired across restarts),
 * and forwards live events to connected phones.
 */
export class PhoneScreen {
  #server: PhoneServer | null = null;
  #enabled = false;
  #error: string | null = null;
  #applying: Promise<void> = Promise.resolve();

  constructor(
    private readonly o: {
      host: EngineHost;
      secrets: SecretStore;
      rendererRoot: string;
      /** Development and tests: listen only on this address (e.g. 127.0.0.1). */
      listenHost?: string;
      log: Logger;
      onStatus(status: PhoneStatus): void;
    },
  ) {}

  get status(): PhoneStatus {
    const s = this.#server;
    return {
      enabled: this.#enabled,
      running: !!s?.running,
      urls: s?.running ? s.urls() : [],
      clients: s?.clients ?? 0,
      error: this.#error,
    };
  }

  /** Follows the setting; calls are serialized. */
  apply(enabled: boolean): Promise<void> {
    this.#applying = this.#applying.then(() => this.#apply(enabled));
    return this.#applying;
  }

  async #apply(enabled: boolean) {
    if (enabled === this.#enabled && (!enabled || this.#server?.running)) return;
    this.#enabled = enabled;
    this.#error = null;
    try {
      if (enabled) {
        const server = this.#server ?? (await this.#create());
        await server.start();
      } else {
        await this.#server?.stop();
      }
    } catch (err) {
      this.#error = "The phone screen couldn't start on this network.";
      this.o.log.warn('phone screen failed to start', { err });
    }
    this.o.onStatus(this.status);
  }

  async #create(): Promise<PhoneServer> {
    let token = await this.o.secrets.get(TOKEN_REF).catch(() => null);
    if (!token) {
      token = newPhoneToken();
      await this.o.secrets.set(TOKEN_REF, token);
    }
    const { host } = this.o;
    this.#server = new PhoneServer(token, {
      rendererRoot: this.o.rendererRoot,
      ...(this.o.listenHost ? { host: this.o.listenHost } : {}),
      log: this.o.log,
      onClients: () => this.o.onStatus(this.status),
      commands: {
        snapshot: async () => ({
          state: await host.call('live.state'),
          transcript: await host.call('live.transcript'),
          answers: await host.call('live.answers'),
        }),
        answerNow: () => host.call('live.answerNow'),
        regenerate: (answerId, length) => host.call('live.regenerate', { answerId, length }),
      },
    });
    return this.#server;
  }

  /** New pairing token: every paired phone has to scan again. */
  async unpair(): Promise<PhoneStatus> {
    const token = newPhoneToken();
    await this.o.secrets.set(TOKEN_REF, token);
    this.#server?.setToken(token);
    this.o.log.info('phones unpaired');
    this.o.onStatus(this.status);
    return this.status;
  }

  broadcast(event: string, data: unknown): void {
    this.#server?.broadcast(event, data);
  }

  async stop(): Promise<void> {
    await this.#server?.stop();
  }
}
