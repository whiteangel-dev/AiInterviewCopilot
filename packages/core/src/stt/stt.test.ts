import type { LiveConnectConfig, LiveServerMessage } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSttProvider } from './fake';
import {
  DEFAULT_LIVE_TIMING,
  GeminiLiveStt,
  isFatalLiveError,
  type LiveConnectionCallbacks,
  type LiveConnector,
} from './gemini-live';
import type { SttHandlers } from './types';

class FakeConn {
  sent = 0;
  ended = false;
  closed = false;
  constructor(
    readonly config: LiveConnectConfig,
    readonly callbacks: LiveConnectionCallbacks,
  ) {}
  emit(message: Partial<LiveServerMessage>) {
    this.callbacks.onMessage(message as LiveServerMessage);
  }
  drop(code = 1011, reason = 'internal error') {
    this.callbacks.onClose(code, reason);
  }
}

/** A connector whose connections open after `delayMs`, or fail with `failWith`. */
function fakeConnector(opts: { delayMs?: number; failWith?: () => string | null } = {}) {
  const conns: FakeConn[] = [];
  const connector: LiveConnector = (params, callbacks) =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        const failure = opts.failWith?.() ?? null;
        if (failure) return reject(new Error(failure));
        const conn = new FakeConn(params.config, callbacks);
        conns.push(conn);
        resolve({
          send: () => void conn.sent++,
          endAudio: () => void (conn.ended = true),
          close: () => void (conn.closed = true),
        });
      }, opts.delayMs ?? 10);
    });
  return { conns, connector };
}

function recorder() {
  const events: string[] = [];
  const handlers: SttHandlers = {
    onInterim: (t) => events.push(`interim:${t}`),
    onFinal: (t) => events.push(`final:${t}`),
    onState: (s, d) => events.push(`state:${s}${d ? `:${d}` : ''}`),
  };
  return { events, handlers };
}

const pcm = new Int16Array(320);
const OPTIONS = { apiKey: 'k', model: 'm', vocabulary: ['KestrelPay'], label: 'interviewer' };

describe('GeminiLiveStt', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const provider = (connector: LiveConnector, timing = {}) =>
    new GeminiLiveStt(connector, { ...DEFAULT_LIVE_TIMING, ...timing }, () => Date.now());

  it('maps interim and final transcripts and buffers audio until connected', async () => {
    const { conns, connector } = fakeConnector({ delayMs: 50 });
    const { events, handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    for (let i = 0; i < 10; i++) stream.write(pcm, true);
    await vi.advanceTimersByTimeAsync(60);
    const conn = conns[0]!;
    expect(conn.sent).toBe(10);
    expect(conn.config.inputAudioTranscription?.customVocabulary).toEqual(['KestrelPay']);
    stream.write(pcm, true);
    expect(conn.sent).toBe(11);

    conn.emit({ serverContent: { interimInputTranscription: { text: 'Tell me' } } });
    conn.emit({ serverContent: { interimInputTranscription: { text: 'Tell me about' } } });
    conn.emit({ serverContent: { inputTranscription: { text: 'Tell me about it.' } } });
    // Finals that arrive in pieces are joined.
    conn.emit({ serverContent: { inputTranscription: { text: 'Why ', finished: false } } });
    conn.emit({ serverContent: { inputTranscription: { text: 'here?', finished: true } } });
    expect(events).toEqual([
      'state:connecting',
      'state:connected',
      'interim:Tell me',
      'interim:Tell me about',
      'final:Tell me about it.',
      'final:Why here?',
    ]);
    expect(stream.stats.audioSeconds).toBeCloseTo(0.22);
    stream.close();
    expect(conn.closed).toBe(true);
  });

  it('sends only speech, with padding, and ends the audio after each utterance', async () => {
    const { conns, connector } = fakeConnector();
    const { handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(20);
    const conn = conns[0]!;
    // Two seconds of silence: nothing sent.
    for (let i = 0; i < 100; i++) stream.write(pcm, false);
    expect(conn.sent).toBe(0);
    // Speech: 400 ms from before it (20 frames), then the speech itself.
    for (let i = 0; i < 50; i++) stream.write(pcm, true);
    expect(conn.sent).toBe(20 + 50);
    // 800 ms after it (40 frames), then the stream is ended and sending stops.
    for (let i = 0; i < 39; i++) stream.write(pcm, false);
    expect(conn.ended).toBe(false);
    stream.write(pcm, false);
    expect(conn.ended).toBe(true);
    for (let i = 0; i < 100; i++) stream.write(pcm, false);
    expect(conn.sent).toBe(110);
    // Billed audio: 2.2 s instead of 4.9 s.
    expect(stream.stats.audioSeconds).toBeCloseTo(2.2);
    stream.close();
  });

  it('keeps an idle connection open with a little silence', async () => {
    const { conns, connector } = fakeConnector();
    const { handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(20);
    const conn = conns[0]!;
    for (let s = 0; s < 40; s++) {
      vi.advanceTimersByTime(1000);
      stream.write(pcm, false);
    }
    // About every 15 s, 100 ms of silence.
    expect(conn.sent).toBe(2);
    expect(stream.stats.audioSeconds).toBeCloseTo(0.2);
    stream.close();
  });

  it('can send everything when the gate is off', async () => {
    const { conns, connector } = fakeConnector();
    const { handlers } = recorder();
    const stream = provider(connector, { gate: null }).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(20);
    for (let i = 0; i < 30; i++) stream.write(pcm, false);
    expect(conns[0]!.sent).toBe(30);
    stream.close();
  });

  it('reconnects after a drop, keeps the partial utterance and resends buffered audio', async () => {
    const { conns, connector } = fakeConnector();
    const { events, handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(20);
    conns[0]!.emit({ serverContent: { interimInputTranscription: { text: 'So tell me' } } });
    conns[0]!.drop();
    expect(events.slice(-2)).toEqual(['final:So tell me', 'state:reconnecting:Reconnecting…']);
    for (let i = 0; i < 5; i++) stream.write(pcm, true);
    await vi.advanceTimersByTimeAsync(300); // first retry after 250 ms + connect
    expect(conns).toHaveLength(2);
    expect(conns[1]!.sent).toBe(5);
    expect(events.at(-1)).toBe('state:connected');
    expect(stream.stats.reconnects).toBe(1);
    stream.close();
  });

  it('rolls over to a new connection at a pause when the server says goAway', async () => {
    const { conns, connector } = fakeConnector();
    const { events, handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(20);
    const first = conns[0]!;
    first.emit({ goAway: { timeLeft: '50s' } });
    expect(conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20); // next connection ready
    expect(conns).toHaveLength(2);
    const second = conns[1]!;

    // Still talking: audio stays on the first connection.
    for (let i = 0; i < 20; i++) stream.write(pcm, true);
    expect(first.sent).toBe(20);
    expect(second.sent).toBe(0);
    // 200 ms of silence: switch.
    for (let i = 0; i < 12; i++) stream.write(pcm, false);
    expect(first.ended).toBe(true);
    expect(first.sent).toBeLessThan(32);
    expect(second.sent).toBeGreaterThan(0);
    // The old connection may still deliver its last words.
    first.emit({ serverContent: { inputTranscription: { text: 'Thanks.' } } });
    expect(events.at(-1)).toBe('final:Thanks.');
    await vi.advanceTimersByTimeAsync(DEFAULT_LIVE_TIMING.drainMs + 10);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(stream.stats.reconnects).toBe(1);
    expect(events.filter((e) => e.startsWith('state:reconnecting'))).toHaveLength(0);
    stream.close();
  });

  it('rolls over by age even without goAway', async () => {
    const { conns, connector } = fakeConnector();
    const { handlers } = recorder();
    const stream = provider(connector, { rollAfterMs: 1000 }).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(1100);
    stream.write(pcm, false);
    await vi.advanceTimersByTimeAsync(20);
    for (let i = 0; i < 12; i++) stream.write(pcm, false);
    expect(conns).toHaveLength(2);
    expect(conns[0]!.ended).toBe(true);
    stream.close();
  });

  it('stops on errors a reconnect cannot fix', async () => {
    const { conns, connector } = fakeConnector({
      failWith: () => 'closed 1008: API key not valid. Please pass a valid API key.',
    });
    const { events, handlers } = recorder();
    const stream = provider(connector).open({ ...OPTIONS, vocabulary: [] }, handlers);
    await vi.advanceTimersByTimeAsync(5000);
    expect(conns).toHaveLength(0);
    expect(events).toEqual(['state:connecting', 'state:error:Google rejected the API key.']);
    stream.write(pcm, true); // ignored, no crash
    stream.close();
  });

  it('retries without custom vocabulary if the setup is rejected', async () => {
    let calls = 0;
    const { conns, connector } = fakeConnector({
      failWith: () => (++calls === 1 ? 'closed 1007: Request contains an invalid argument.' : null),
    });
    const { handlers } = recorder();
    const stream = provider(connector).open(OPTIONS, handlers);
    await vi.advanceTimersByTimeAsync(50);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.config.inputAudioTranscription?.customVocabulary).toBeUndefined();
    stream.close();
  });

  it('classifies fatal errors', () => {
    expect(isFatalLiveError('API key not valid')).toBe(true);
    expect(isFatalLiveError('models/x is not found for API version v1beta')).toBe(true);
    expect(isFatalLiveError('closed 1011: internal error')).toBe(false);
    expect(isFatalLiveError('network timeout')).toBe(false);
  });
});

describe('FakeSttProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('recognizes the next scripted line while speech is heard', async () => {
    const { events, handlers } = recorder();
    const stream = new FakeSttProvider({ interviewer: ['Tell me about yourself.'] }).open(
      OPTIONS,
      handlers,
    );
    await vi.advanceTimersByTimeAsync(200);
    for (let i = 0; i < 40; i++) stream.write(pcm, true);
    stream.write(pcm, false);
    await vi.advanceTimersByTimeAsync(400);
    expect(events[0]).toBe('state:connecting');
    expect(events).toContain('interim:Tell');
    expect(events).toContain('interim:Tell me about yourself.');
    expect(events.at(-1)).toBe('final:Tell me about yourself.');
    stream.close();
  });
});
