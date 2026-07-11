// dsp.js — 신호처리 유틸

export function goertzelDb(buf, freq, sampleRate) {
  const k = 2 * Math.cos(2 * Math.PI * freq / sampleRate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + k * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const p = Math.max(s1 * s1 + s2 * s2 - k * s1 * s2, 0);
  return 20 * Math.log10(Math.max(Math.sqrt(p) / buf.length, 1e-9));
}

export function detectFreqOnce(analyser, sampleRate) {
  const bins = analyser.frequencyBinCount;
  const data = new Float32Array(bins);
  analyser.getFloatFrequencyData(data);
  const binHz = sampleRate / analyser.fftSize;
  const lo = Math.max(1, Math.floor(40 / binHz));
  const hi = Math.min(bins - 2, Math.ceil(400 / binHz));
  let pk = lo;
  for (let i = lo; i <= hi; i++) if (data[i] > data[pk]) pk = i;
  const a = data[pk - 1], b = data[pk], c = data[pk + 1], d = a - 2 * b + c;
  let f = pk * binHz;
  if (Math.abs(d) > 1e-9) f = (pk + 0.5 * (a - c) / d) * binHz;
  return f;
}

// 대역별 평균 레벨(dB) — 마스킹 스펙트럼 셰이핑용
export function bandLevels(analyser, sampleRate, bands) {
  const n = analyser.frequencyBinCount;
  const data = new Float32Array(n);
  analyser.getFloatFrequencyData(data);
  const binHz = sampleRate / analyser.fftSize;
  return bands.map(([lo, hi]) => {
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.min(n - 1, Math.ceil(hi / binHz));
    let s = 0, c = 0;
    for (let i = a; i <= b; i++) { s += data[i]; c++; }
    return c ? s / c : -100;
  });
}

// 브라운 노이즈 버퍼(-6dB/oct) — 팬 소음과 유사한 기울기
export function makeBrownNoise(ctx, seconds = 8) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

// 토널성: 40~2000Hz에서 최대 피크가 스펙트럼 바닥(중앙값) 대비 몇 dB 돌출했는지
export function tonalPeak(analyser, sampleRate) {
  const n = analyser.frequencyBinCount;
  const data = new Float32Array(n);
  analyser.getFloatFrequencyData(data);
  const binHz = sampleRate / analyser.fftSize;
  const lo = Math.max(1, Math.floor(40 / binHz));
  const hi = Math.min(n - 2, Math.ceil(2000 / binHz));
  const seg = [];
  let pk = lo;
  for (let i = lo; i <= hi; i++) { seg.push(data[i]); if (data[i] > data[pk]) pk = i; }
  seg.sort((a, b) => a - b);
  const floor = seg[Math.floor(seg.length / 2)];
  return { freq: pk * binHz, prom: data[pk] - floor };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
