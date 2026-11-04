import type {
  AnswerLength,
  AudioChannel,
  LiveAnswer,
  LiveState,
  LiveTranscript,
  LiveTranscriptUpdate,
  LiveTurnUpdate,
  TranscriptSegment,
  TurnPhase,
} from '@aic/ipc';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { AnswerCard } from '../components/live/answer-card';
import { TranscriptView } from '../components/live/transcript-view';
import { cn } from '../lib/utils';

/**
 * The phone second screen: the live answer and transcript from the computer
 * running the interview, over the local network (server-sent events). The
 * buttons send Answer now / Regenerate back to the computer.
 */

interface Feed {
  connection: 'connecting' | 'live' | 'lost';
  state: LiveState | null;
  segments: TranscriptSegment[];
  interim: Partial<Record<AudioChannel, TranscriptSegment>>;
  answers: LiveAnswer[];
  phase: TurnPhase;
}

type Action =
  | { type: 'connection'; value: Feed['connection'] }
  | {
      type: 'snapshot';
      state: LiveState | null;
      transcript: LiveTranscript | null;
      answers: LiveAnswer[];
    }
  | { type: 'state'; state: LiveState | null }
  | { type: 'transcript'; update: LiveTranscriptUpdate }
  | { type: 'answer'; answer: LiveAnswer }
  | { type: 'turn'; update: LiveTurnUpdate };

const MAX_SEGMENTS = 200;

function reduce(feed: Feed, action: Action): Feed {
  switch (action.type) {
    case 'connection':
      return { ...feed, connection: action.value };
    case 'snapshot':
      return {
        ...feed,
        connection: 'live',
        state: action.state,
        segments: action.transcript?.segments.slice(-MAX_SEGMENTS) ?? [],
        interim: action.transcript?.interim ?? {},
        answers: action.answers.filter((a) => a.status !== 'withdrawn'),
        phase: 'idle',
      };
    case 'state':
      // A new interview starts with an empty screen.
      if (action.state?.id !== feed.state?.id) {
        return {
          ...feed,
          state: action.state,
          segments: [],
          interim: {},
          answers: [],
          phase: 'idle',
        };
      }
      return { ...feed, state: action.state };
    case 'transcript': {
      const { segment, kind } = action.update;
      if (action.update.id !== feed.state?.id) return feed;
      const interim = { ...feed.interim };
      if (kind === 'interim') {
        if (segment.text) interim[segment.channel] = segment;
        else delete interim[segment.channel];
        return { ...feed, interim };
      }
      delete interim[segment.channel];
      return { ...feed, interim, segments: [...feed.segments, segment].slice(-MAX_SEGMENTS) };
    }
    case 'answer': {
      const a = action.answer;
      if (a.runId !== feed.state?.id) return feed;
      const i = feed.answers.findIndex((x) => x.id === a.id);
      if (a.status === 'withdrawn') {
        return i < 0 ? feed : { ...feed, answers: feed.answers.filter((_, j) => j !== i) };
      }
      const answers = i < 0 ? [...feed.answers, a] : feed.answers.map((x, j) => (j === i ? a : x));
      return { ...feed, answers };
    }
    case 'turn':
      return action.update.id === feed.state?.id ? { ...feed, phase: action.update.phase } : feed;
  }
}

function useFeed(): Feed {
  const [feed, dispatch] = useReducer(reduce, {
    connection: 'connecting',
    state: null,
    segments: [],
    interim: {},
    answers: [],
    phase: 'idle',
  });
  useEffect(() => {
    // EventSource reconnects by itself; the server sends a fresh snapshot each time.
    const source = new EventSource('/api/events');
    const on = <T,>(event: string, fn: (data: T) => void) =>
      source.addEventListener(event, (e) => fn(JSON.parse((e as MessageEvent<string>).data) as T));
    on<{ state: LiveState | null; transcript: LiveTranscript | null; answers: LiveAnswer[] }>(
      'snapshot',
      (s) => dispatch({ type: 'snapshot', ...s }),
    );
    on<LiveState | null>('live:state', (state) => dispatch({ type: 'state', state }));
    on<LiveTranscriptUpdate>('live:transcript', (update) =>
      dispatch({ type: 'transcript', update }),
    );
    on<LiveAnswer>('live:answer', (answer) => dispatch({ type: 'answer', answer }));
    on<LiveTurnUpdate>('live:turn', (update) => dispatch({ type: 'turn', update }));
    source.onerror = () => dispatch({ type: 'connection', value: 'lost' });
    source.onopen = () => dispatch({ type: 'connection', value: 'live' });
    return () => source.close();
  }, []);
  return feed;
}

async function command(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIC-Phone': '1' },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    if (res.status === 403) return 'This phone is no longer paired. Scan the QR code again.';
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    return data?.message ?? 'That didn’t work.';
  } catch {
    return 'Can’t reach the computer.';
  }
}

export function PhoneApp() {
  const feed = useFeed();
  const [notice, setNotice] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(true);
  const interview = feed.state?.mode === 'interview' ? feed.state : null;
  const status = interview?.status;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const run = (body: Record<string, unknown>) =>
    void command(body).then((error) => error && setNotice(error));

  return (
    <div className="flex h-dvh flex-col text-[16px]" data-testid="phone">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 pt-[env(safe-area-inset-top)]">
        <span
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            feed.connection !== 'live'
              ? 'bg-muted-foreground/40'
              : status === 'live'
                ? 'animate-pulse bg-destructive'
                : status === 'paused'
                  ? 'bg-warning'
                  : 'bg-success',
          )}
          aria-hidden
        />
        <span className="text-sm font-semibold" data-testid="phone-status">
          {feed.connection === 'connecting'
            ? 'Connecting…'
            : feed.connection === 'lost'
              ? 'Reconnecting to your computer…'
              : status === 'live'
                ? 'Listening'
                : status === 'paused'
                  ? 'Paused'
                  : 'Connected · waiting for an interview'}
        </span>
      </header>

      {notice && (
        <div
          className="border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {notice}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <AnswerCard
          answers={feed.answers}
          phase={feed.phase}
          live={status === 'live'}
          answerNowHint={null}
          onAnswerNow={() => run({ action: 'answerNow' })}
          onRegenerate={(answerId: string, length: AnswerLength | null) =>
            run({ action: 'regenerate', answerId, length })
          }
          className="min-h-0 flex-1 text-[17px]"
        />
        <section className="shrink-0 rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setShowTranscript(!showTranscript)}
            className="flex h-9 w-full items-center justify-between px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            aria-expanded={showTranscript}
          >
            Transcript
            {showTranscript ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </button>
          {showTranscript && (
            <TranscriptView
              segments={feed.segments}
              interim={feed.interim}
              compact
              className="max-h-[28dvh] px-3 pb-2 text-sm"
              emptyText={interview ? 'Listening…' : 'Start an interview on your computer.'}
            />
          )}
        </section>
      </main>
    </div>
  );
}
