import type { AppError, ModelInfo, ProviderId } from '@aic/ipc';

export type ContentPart = { text: string } | { file: { mimeType: string; data: Uint8Array } };

export interface StructuredRequest {
  apiKey: string;
  model: string;
  system: string;
  parts: ContentPart[];
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
  /** Names the task, for logs and for the offline fake provider. */
  task: string;
  /** `low` asks reasoning models to think briefly (faster, cheaper). */
  effort?: 'low' | 'default';
  signal?: AbortSignal;
  /** Called as the response streams in. */
  onProgress?: (receivedChars: number) => void;
}

export interface StructuredResponse {
  /** Raw JSON text. */
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export interface AiProvider {
  readonly id: ProviderId;
  /** Lists the models this key can use. Doubles as the key check. */
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** One JSON response that follows `schema`. */
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /** Maps an SDK or network error to an AppError with a message fit for the UI. */
  toAppError(err: unknown): AppError;
}
