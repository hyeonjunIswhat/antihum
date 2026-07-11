// engine.js — v2 시분할 설계
// 핵심: 마이크와 출력을 동시에 켜지 않는다.
// 출력 전용 세션 = iOS가 일반 미디어 재생으로 취급 → 정상 볼륨/라우팅.
// 마이크는 측정 순간에만 획득하고 즉시 해제.

import { goertzelDb } from './dsp.js';

export class AudioEngine {
  constructor() {
    this.ctx = null; this.audioEl = null;
    this.oscSin = null; this.oscCos = null;
    this.gSin = null; this.gCos = null; this.master = null;
    this.stream = null; this.analyser = null; this.srcNode = null;
    this.lockedFreq = 0; this.phaseDeg = 0;
    this.timeBuf = new Float32Array(8192);
    this.micLabel = '';
  }

  // ---- 출력 그래프 (마이크 없이 생성 = 순수 재생 세션) ----
  async startOutput() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    this.master = this.ctx.createGain(); this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    const msDest = this.ctx.createMediaStreamDestination();
    this.master.connect(msDest);
    this.audioEl = new Audio();
    this.audioEl.srcObject = msDest.stream;
    this.audioEl.setAttribute('playsinline', '');
    try { await this.audioEl.play(); } catch (_) {}

    this.gSin = this.ctx.createGain(); this.gCos = this.ctx.createGain();
    this.gSin.connect(this.master); this.gCos.connect(this.master);
    this.oscSin = this.ctx.createOscillator(); this.oscSin.type = 'sine';
    const cosWave = this.ctx.createPeriodicWave(
      new Float32Array([0, 1]), new Float32Array([0, 0]),
      { disableNormalization: true });
    this.oscCos = this.ctx.createOscillator();
    this.oscCos.setPeriodicWave(cosWave);
    const t0 = this.ctx.currentTime + 0.05;
    this.oscSin.start(t0); this.oscCos.start(t0);
    this.setPhase(0);
  }

  // ---- 마이크: 필요할 때만 켜고 반드시 끈다 ----
  async micOn() {
    const micOpts = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: micOpts });
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const inputs = devs.filter(d => d.kind === 'audioinput');
      const builtin = inputs.find(d => /iphone|아이폰|내장|built/i.test(d.label));
      const cur = this.stream.getAudioTracks()[0];
      this.micLabel = cur.label || '기본';
      if (builtin && builtin.label !== cur.label) {
        cur.stop();
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
          ...micOpts, deviceId: { exact: builtin.deviceId } } });
        this.micLabel = this.stream.getAudioTracks()[0].label;
      }
    } catch (_) {}
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 32768;
    this.analyser.smoothingTimeConstant = 0.4;
    this.srcNode.connect(this.analyser);
  }

  micOff() {
    if (this.srcNode) { try { this.srcNode.disconnect(); } catch (_) {} this.srcNode = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.analyser = null;
    // 재생 세션 복귀 재확인
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    if (this.audioEl) this.audioEl.play().catch(() => {});
  }

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

  teardown() {
    this.micOff();
    if (this.audioEl) { try { this.audioEl.pause(); this.audioEl.srcObject = null; } catch (_) {} this.audioEl = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
    this.ctx = null;
  }
}
