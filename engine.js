// engine.js — 오디오 엔진 (시분할: 마이크와 출력은 절대 동시에 켜지 않음)
// 출력은 마이크 없는 순수 재생 세션 = iOS가 유튜브와 동일하게 취급 → 정상 볼륨/라우팅

import { goertzelDb, makeBrownNoise } from './dsp.js';

export class AudioEngine {
  constructor() {
    this.ctx = null; this.audioEl = null; this.msDest = null;
    this.oscSin = null; this.oscCos = null;
    this.gSin = null; this.gCos = null; this.master = null;   // 험 상쇄 체인
    this.maskSrc = null; this.maskGain = null; this.maskBuf = null; // 마스킹 체인
    this.hMix = null; this.hSin = null; this.hCos = null;     // 기능테스트 험
    this.stream = null; this.analyser = null; this.srcNode = null;
    this.lockedFreq = 0; this.phaseDeg = 0; this.humDeg = null;
    this.timeBuf = new Float32Array(8192);
  }

  async startOutput() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    this.msDest = this.ctx.createMediaStreamDestination();
    this.audioEl = new Audio();
    this.audioEl.srcObject = this.msDest.stream;
    this.audioEl.setAttribute('playsinline', '');
    try { await this.audioEl.play(); } catch (_) {}

    // --- 험 상쇄 체인 ---
    this.master = this.ctx.createGain(); this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    this.master.connect(this.msDest);
    this.gSin = this.ctx.createGain(); this.gCos = this.ctx.createGain();
    this.gSin.connect(this.master); this.gCos.connect(this.master);
    this.oscSin = this.ctx.createOscillator(); this.oscSin.type = 'sine';
    const cosWave = this.ctx.createPeriodicWave(
      new Float32Array([0, 1]), new Float32Array([0, 0]),
      { disableNormalization: true });
    this.oscCos = this.ctx.createOscillator();
    this.oscCos.setPeriodicWave(cosWave);
    const t0 = this.ctx.currentTime + 0.05;
    this.oscStartTime = t0;
    this.oscSin.start(t0); this.oscCos.start(t0);
    this.setPhase(0);

    // 위상 캡처용 워크릿 (샘플 단위 타임스탬프) — 실패해도 앱은 탭 방식으로 동작
    this.workletOk = false;
    try {
      const code = "class Cap extends AudioWorkletProcessor{process(inputs){const c=inputs[0][0];if(c)this.port.postMessage({f:currentFrame,d:c.slice(0)});return true;}}registerProcessor('cap',Cap);";
      await this.ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      this.workletOk = true;
    } catch (_) {}
  }

  // ---- 마이크 (측정 순간에만) ----
  async micOn() {
    // 세션도 시분할: 캡처 직전에만 play-and-record (playback 세션은 마이크 캡처 거부)
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (_) {}
    const micOpts = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: micOpts });
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const builtin = devs.filter(d => d.kind === 'audioinput')
        .find(d => /iphone|아이폰|내장|built/i.test(d.label));
      const cur = this.stream.getAudioTracks()[0];
      if (builtin && builtin.label !== cur.label) {
        cur.stop();
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
          ...micOpts, deviceId: { exact: builtin.deviceId } } });
      }
    } catch (_) {}
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 32768;
    this.analyser.smoothingTimeConstant = 0.5;
    this.srcNode.connect(this.analyser);
    // 위상 캡처 시작
    this.capChunks = [];
    if (this.workletOk) {
      try {
        this.capNode = new AudioWorkletNode(this.ctx, 'cap');
        this.capNode.port.onmessage = (e) => {
          if (this.capChunks.length * 128 < this.ctx.sampleRate * 4) // 최대 4초
            this.capChunks.push(e.data);
        };
        this.srcNode.connect(this.capNode);
      } catch (_) { this.capNode = null; }
    }
  }

  micOff() {
    if (this.capNode) { try { this.capNode.port.onmessage = null; this.capNode.disconnect(); } catch (_) {} this.capNode = null; }
    if (this.srcNode) { try { this.srcNode.disconnect(); } catch (_) {} this.srcNode = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.analyser = null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    if (this.audioEl) this.audioEl.play().catch(() => {});
  }

  // ---- 험 상쇄 ----
  setFreq(f) {
    this.lockedFreq = f;
    this.oscSin.frequency.setValueAtTime(f, this.ctx.currentTime);
    this.oscCos.frequency.setValueAtTime(f, this.ctx.currentTime);
  }
  setPhase(deg) {
    this.phaseDeg = ((deg % 360) + 360) % 360;
    const phi = this.phaseDeg * Math.PI / 180, t = this.ctx.currentTime;
    this.gSin.gain.setTargetAtTime(Math.cos(phi), t, 0.02);
    this.gCos.gain.setTargetAtTime(Math.sin(phi), t, 0.02);
  }
  applyMaster(level) {
    if (this.master) this.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05);
  }
  measureResidualOnce() {
    if (!this.analyser) return -80;
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    return goertzelDb(this.timeBuf, this.lockedFreq, this.ctx.sampleRate);
  }

  // ---- 스마트 마스킹: 측정 스펙트럼에 맞춘 셰이핑 브라운 노이즈 ----
  // shape: 4개 dB 오프셋 [저역쉘프120, 피크300, 피크800, 고역쉘프2000]
  startMasking(shape, level) {
    this.stopMasking();
    if (!this.maskBuf) this.maskBuf = makeBrownNoise(this.ctx, 8);
    this.maskSrc = this.ctx.createBufferSource();
    this.maskSrc.buffer = this.maskBuf;
    this.maskSrc.loop = true;

    const mk = (type, freq, gain, q) => {
      const f = this.ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      f.gain.value = Math.max(-12, Math.min(12, gain));
      if (q) f.Q.value = q;
      return f;
    };
    const f1 = mk('lowshelf', 120, shape[0]);
    const f2 = mk('peaking', 300, shape[1], 0.9);
    const f3 = mk('peaking', 800, shape[2], 0.9);
    const f4 = mk('highshelf', 2000, shape[3]);
    this.maskGain = this.ctx.createGain(); this.maskGain.gain.value = 0;

    this.maskSrc.connect(f1); f1.connect(f2); f2.connect(f3); f3.connect(f4);
    f4.connect(this.maskGain);
    this.maskGain.connect(this.ctx.destination);
    this.maskGain.connect(this.msDest);
    this.maskSrc.start();
    this.setMaskLevel(level);
  }
  setMaskLevel(v) {
    if (this.maskGain)
      this.maskGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.15);
  }
  stopMasking() {
    if (this.maskSrc) { try { this.maskSrc.stop(); this.maskSrc.disconnect(); } catch (_) {} this.maskSrc = null; }
    if (this.maskGain) { try { this.maskGain.disconnect(); } catch (_) {} this.maskGain = null; }
  }

  // ---- 기능테스트용 가짜 험 (정답 위상 ψ) ----
  startFakeHum(deg, vol) {
    this.stopFakeHum();
    const phi = deg * Math.PI / 180;
    this.hSin = this.ctx.createGain(); this.hSin.gain.value = Math.cos(phi);
    this.hCos = this.ctx.createGain(); this.hCos.gain.value = Math.sin(phi);
    this.hMix = this.ctx.createGain(); this.hMix.gain.value = vol;
    this.oscSin.connect(this.hSin); this.oscCos.connect(this.hCos);
    this.hSin.connect(this.hMix); this.hCos.connect(this.hMix);
    this.hMix.connect(this.ctx.destination);
    this.hMix.connect(this.msDest);
    this.humDeg = deg;
  }
  stopFakeHum() {
    if (this.hMix) {
      try { this.oscSin.disconnect(this.hSin); this.oscCos.disconnect(this.hCos);
            this.hMix.disconnect(); } catch (_) {}
      this.hSin = this.hCos = this.hMix = null;
    }
  }

  // 캡처된 마이크 샘플로 소음의 절대 위상 측정 (컨텍스트 타임라인 기준)
  // 반환: x(t) ≈ A·cos(2πf·t + φ) 의 φ (deg), 신뢰 불가 시 null
  computeNoisePhase(freq) {
    if (!this.capChunks || !this.capChunks.length) return null;
    const sr = this.ctx.sampleRate;
    let re = 0, im = 0, n = 0;
    for (const ch of this.capChunks) {
      const base = ch.f;
      const d = ch.d;
      for (let i = 0; i < d.length; i++) {
        const ang = 2 * Math.PI * freq * (base + i) / sr;
        re += d[i] * Math.cos(ang);
        im -= d[i] * Math.sin(ang);
        n++;
      }
    }
    if (n < sr * 1.5) return null; // 1.5초 미만이면 신뢰 불가
    const amp = 2 * Math.hypot(re, im) / n;
    if (amp < 1e-4) return null;   // 성분이 너무 약함
    return ((Math.atan2(im, re) * 180 / Math.PI) % 360 + 360) % 360;
  }

  teardown() {
    this.micOff();
    this.stopMasking();
    this.stopFakeHum();
    if (this.audioEl) { try { this.audioEl.pause(); this.audioEl.srcObject = null; } catch (_) {} this.audioEl = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
    this.ctx = null;
  }
}
