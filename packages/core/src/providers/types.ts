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

/** A streamed text (or JSON) reply, for the live path where every millisecond counts. */
export interface TextStreamRequest {
  apiKey: string;
  model: string;
  system: string;
  /** The user message. */
  text: string;
  /** JSON Schema for a JSON reply; plain text when absent. */
  schema?: Record<string, unknown>;
  /**
   * `minimal`: as little thinking as the model allows (live answers, turn
   * analysis); `low`: brief thinking (the Quality answer mode).
   */
  thinking: 'minimal' | 'low';
  maxOutputTokens: number;
  /** Names the task, for logs and for the offline fake provider. */
  task: string;
  signal?: AbortSignal;
  /** Each piece of visible text as it arrives. */
  onText?: (piece: string) => void;
}

export interface TextStreamResponse {
  text: string;
  model: string;
  inputTokens: number | null;
  /** Input tokens served from the provider's cache (implicit caching). */
  cachedTokens: number | null;
  outputTokens: number | null;
  /** Request start → first visible text (ms). */
  firstTextMs: number | null;
  durationMs: number;
  finishReason: string | null;
}

export interface AiProvider {
  readonly id: ProviderId;
  /** Lists the models this key can use. Doubles as the key check. */
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** One JSON response that follows `schema`. */
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /** A streamed reply (live answers and turn analysis). */
  streamText(request: TextStreamRequest): Promise<TextStreamResponse>;
  /** Opens a connection to the provider ahead of the first live request. Never throws. */
  warmUp(apiKey: string, model: string): Promise<void>;
  /** Maps an SDK or network error to an AppError with a message fit for the UI. */
  toAppError(err: unknown): AppError;
}
