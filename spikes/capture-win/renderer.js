// Phase 0 — Option A capture spike renderer.
// Captures system audio (loopback) + microphone on one 16 kHz AudioContext clock,
// shows levels, tracks dropouts/gaps and CPU, and saves 16 kHz mono WAVs + a JSON report.
const RATE = 16000;
const FRAME = 1600; // 100 ms per worklet message
const MAX_MINUTES = 15;

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  $('log').textContent += `${new Date().toISOString().slice(11, 23)}  ${msg}\n`;
  $('log').scrollTop = 1e9;
};

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const a = input[0], b = input[1];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) / 2 : a[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

let ctx = null;
let channels = {};
let streams = [];
let startedAt = 0;
let timers = [];
let cpuSamples = [];

function newChannel(name, track) {
  return { name, label: track.label, settings: track.getSettings(), chunks: [], samples: 0, lastAt: 0, maxGapMs: 0, gaps: 0, db: -Infinity, active: [] };
}

async function attach(ch, stream) {
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph pulled without playing anything back
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
    const now = performance.now();
    if (ch.lastAt) {
      const gap = now - ch.lastAt;
      ch.maxGapMs = Math.max(ch.maxGapMs, gap);
      if (gap > 250) ch.gaps++;
    }
    ch.lastAt = now;
    ch.chunks.push(data);
    ch.samples += data.length;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    ch.db = 10 * Math.log10(sum / data.length + 1e-12);
    ch.active.push(ch.db > -45);
  };
}

async function refreshMics() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const current = $('mic').value;
  $('mic').innerHTML = devices.map((d) => `<option value="${d.deviceId}">${d.label || 'Microphone'}</option>`).join('');
  if (devices.some((d) => d.deviceId === current)) $('mic').value = current;
}

async function start() {
  $('start').disabled = true;
  channels = {};
  streams = [];
  cpuSamples = [];
  ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));

  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    display.getVideoTracks().forEach((t) => t.stop());
    const track = display.getAudioTracks()[0];
    if (!track) throw new Error('no loopback audio track was returned');
    channels.sys = newChannel('interviewer', track);
    await attach(channels.sys, new MediaStream([track]));
    streams.push(display);
    track.onended = () => log('system audio track ENDED');
    log(`system audio OK: ${JSON.stringify(channels.sys.settings)}`);
  } catch (e) {
    log(`SYSTEM AUDIO FAILED: ${e.name}: ${e.message}`);
  }

  try {
    const deviceId = $('mic').value;
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const track = mic.getAudioTracks()[0];
    channels.mic = newChannel('mic', track);
    await attach(channels.mic, mic);
    streams.push(mic);
    track.onended = () => log('microphone track ENDED (device removed?)');
    log(`microphone OK: ${track.label} ${JSON.stringify(channels.mic.settings)}`);
  } catch (e) {
    log(`MICROPHONE FAILED: ${e.name}: ${e.message}`);
  }

  startedAt = performance.now();
  $('stop').disabled = false;
  timers.push(setInterval(async () => cpuSamples.push(await window.spike.metrics()), 1000));
  timers.push(setInterval(renderStats, 500));
  timers.push(setTimeout(() => stop(), MAX_MINUTES * 60_000));
  requestAnimationFrame(drawMeters);
}

function drawMeters() {
  for (const [key, bar, label] of [['sys', 'sysBar', 'sysDb'], ['mic', 'micBar', 'micDb']]) {
    const ch = channels[key];
    if (!ch) continue;
    $(bar).style.width = `${Math.max(0, Math.min(100, ((ch.db + 60) / 60) * 100))}%`;
    $(label).textContent = Number.isFinite(ch.db) ? `${ch.db.toFixed(0)} dBFS` : '';
  }
  if (startedAt) requestAnimationFrame(drawMeters);
}

const pct = (xs) => (xs.length ? Math.round((100 * xs.filter(Boolean).length) / xs.length) : 0);

function summary() {
  const elapsedS = (performance.now() - startedAt) / 1000;
  const sys = channels.sys?.active ?? [];
  const mic = channels.mic?.active ?? [];
  const n = Math.min(sys.length, mic.length);
  const cpu = cpuSamples.map((m) => m.cpuPercent);
  return {
    elapsedS: +elapsedS.toFixed(1),
    contextSampleRate: ctx?.sampleRate,
    contextBaseLatencyMs: ctx ? +(ctx.baseLatency * 1000).toFixed(1) : null,
    channels: Object.values(channels).map((ch) => ({
      channel: ch.name,
      device: ch.label,
      sourceSampleRate: ch.settings.sampleRate,
      sourceChannelCount: ch.settings.channelCount,
      receivedS: +(ch.samples / RATE).toFixed(2),
      missingMs: Math.round((elapsedS - ch.samples / RATE) * 1000),
      maxGapMs: Math.round(ch.maxGapMs),
      gapsOver250ms: ch.gaps,
      activePct: pct(ch.active),
    })),
    // Share of 100 ms frames where both channels are above -45 dBFS. High values
    // while only the interviewer talks indicate speaker echo into the microphone.
    bothActivePct: n ? Math.round((100 * sys.slice(0, n).filter((v, i) => v && mic[i]).length) / n) : 0,
    cpuAvgPct: cpu.length ? +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1) : null,
    cpuMaxPct: cpu.length ? +Math.max(...cpu).toFixed(1) : null,
    memoryMB: cpuSamples.length ? Math.round(cpuSamples[cpuSamples.length - 1].memoryMB) : null,
  };
}

function renderStats() {
  if (!startedAt) return;
  const s = summary();
  $('elapsed').textContent = `${s.elapsedS}s`;
  const rows = [
    ['AudioContext', `${s.contextSampleRate} Hz, base latency ${s.contextBaseLatencyMs} ms`],
    ...s.channels.map((c) => [c.channel, `${c.device} · source ${c.sourceSampleRate ?? '?'} Hz × ${c.sourceChannelCount ?? '?'} ch · missing ${c.missingMs} ms · max gap ${c.maxGapMs} ms · gaps>250ms ${c.gapsOver250ms} · active ${c.activePct}%`]),
    ['Both active', `${s.bothActivePct}% of frames`],
    ['App CPU / memory', `${s.cpuAvgPct ?? '—'}% avg, ${s.cpuMaxPct ?? '—'}% max · ${s.memoryMB ?? '—'} MB`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
}

function encodeWav(chunks, total) {
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const x = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

async function stop() {
  if (!startedAt) return;
  $('stop').disabled = true;
  const report = summary();
  timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  timers = [];
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  startedAt = 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const ch of Object.values(channels)) {
    const file = await window.spike.saveFile(`${stamp}-${ch.name}.wav`, encodeWav(ch.chunks, ch.samples));
    log(`saved ${file}`);
  }
  const info = await window.spike.systemInfo();
  const json = JSON.stringify({ ...info, ...report, log: $('log').textContent }, null, 2);
  log(`saved ${await window.spike.saveFile(`${stamp}-report.json`, new TextEncoder().encode(json))}`);
  await ctx.close();
  $('start').disabled = false;
}

$('start').onclick = () => start().catch((e) => { log(`START FAILED: ${e.message}`); $('start').disabled = false; });
$('stop').onclick = () => stop().catch((e) => log(`STOP FAILED: ${e.message}`));
navigator.mediaDevices.ondevicechange = () => { log('audio devices changed'); refreshMics(); };

(async () => {
  const info = await window.spike.systemInfo();
  $('sysinfo').textContent = `${info.platform} ${info.osRelease} · Electron ${info.electron} (Chrome ${info.chrome}) · recordings → ${info.recordingsDir}`;
  try {
    // Ask once so device labels are available, then release the mic.
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
  } catch (e) {
    log(`microphone permission: ${e.message}`);
  }
  await refreshMics();
})();
