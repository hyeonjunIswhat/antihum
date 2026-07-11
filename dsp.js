// dsp.js — 신호처리 유틸 (스모크테스트 검증 완료 로직)

// 특정 주파수 성분의 레벨(dB) — Goertzel
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

// FFT 피크 검출 (40–400Hz, 로그 도메인 포물선 보간)
export function detectFreqOnce(analyser, sampleRate) {
  const bins = analyser.frequencyBinCount;
  const data = new Float32Array(bins);
  analyser.getFloatFrequencyData(data); // dB 스케일
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

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
