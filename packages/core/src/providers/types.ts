import type { AppError, ModelInfo, ProviderId } from '@aic/ipc';

export interface AiProvider {
  readonly id: ProviderId;
  /** Lists the models this key can use. Doubles as the key check. */
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Maps an SDK or network error to an AppError with a message fit for the UI. */
  toAppError(err: unknown): AppError;
}
