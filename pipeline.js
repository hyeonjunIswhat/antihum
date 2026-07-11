// pipeline.js — 세션 로직: 마스킹 / 험 상쇄 / 기능테스트

import { detectFreqOnce, bandLevels, sleep, median } from './dsp.js';

export const VOL = 0.4;
const BANDS = [[40, 160], [160, 500], [500, 1200], [1200, 3000]];

export class AutoPipeline {
  constructor(engine, ui) {
    this.e = engine; this.ui = ui;
    this.running = false; this.paused = false; this.aborted = false;
    this.state = 'idle';
    this.mode = null;            // 'mask' | 'cancel' | 'demo'
    this.tapResolve = null;
    this.sweepTimer = null;
    this.maskTimer = null;
    this.maskLevel = 0.5;
  }

  // ================= 공통: 마이크 측정 =================
  async detectFreqStable(ms) {
    const t0 = performance.now(); const fs = [];
    while (performance.now() - t0 < ms) {
      fs.push(detectFreqOnce(this.e.analyser, this.e.ctx.sampleRate));
      await sleep(200);
      if (this.aborted) return 0;
    }
    return median(fs);
  }

  async measureSpectrum(ms) {
    const t0 = performance.now(); const acc = [0, 0, 0, 0]; let n = 0;
    let f = 0; const fs = [];
    while (performance.now() - t0 < ms) {
      const lv = bandLevels(this.e.analyser, this.e.ctx.sampleRate, BANDS);
      for (let i = 0; i < 4; i++) acc[i] += lv[i];
      fs.push(detectFreqOnce(this.e.analyser, this.e.ctx.sampleRate));
      n++;
      await sleep(200);
      if (this.aborted) return null;
    }
    f = median(fs);
    return { bands: acc.map(v => v / n), freq: f };
  }

  // ================= 모드 1: 스마트 마스킹 =================
  async runMask(minutes) {
    this.mode = 'mask'; this.state = 'measure';
    this.ui.ring('measure');
    this.ui.stage('소음 스펙트럼 측정 중 (3초, 조용히)');
    this.e.applyMaster(0);
    await this.e.micOn();
    await sleep(400);
    const m = await this.measureSpectrum(2600);
    this.e.micOff();
    if (!m || this.aborted) return;

    // 스펙트럼 → 필터 셰이프: 평균 대비 상대 dB (에너지 큰 대역을 더 두껍게 마스킹)
    const mean = m.bands.reduce((a, b) => a + b, 0) / 4;
    const shape = m.bands.map(v => Math.max(-10, Math.min(10, (v - mean) * 0.8)));
    this.e.startMasking(shape, this.maskLevel);

    this.state = 'mask';
    this.ui.ring('mask');
    this.ui.freq(m.freq, false);
    this.ui.stage('맞춤 마스킹 재생 중 — 소음의 결을 따라 만든 노이즈입니다');
    this.ui.status('스마트 마스킹 동작 중' + (minutes ? ' · ' + minutes + '분 후 자동 종료' : ''));

    if (minutes) {
      this.maskTimer = setTimeout(() => {
        // 페이드아웃 후 종료 신호
        this.e.setMaskLevel(0);
        setTimeout(() => this.ui.onTimerEnd && this.ui.onTimerEnd(), 2000);
      }, minutes * 60000);
    }
  }

  setMaskLevel(v) {
    this.maskLevel = v;
    if (this.mode === 'mask') this.e.setMaskLevel(this.paused ? 0 : v);
  }

  // ================= 모드 2: 험 상쇄 (귀 캘리브레이션) =================
  waitTap() { return new Promise(res => { this.tapResolve = res; }); }
  tap() { if (this.tapResolve) { const r = this.tapResolve; this.tapResolve = null; r(); } }
  stopSweep() { if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; } }

  async measureFreq(label) {
    this.state = 'measure';
    this.ui.ring('measure');
    this.ui.stage(label || '소음 주파수 측정 중 (마이크 3초)');
    this.ui.tapButton(false);
    this.e.applyMaster(0);
    await this.e.micOn();
    await sleep(400);
    const f = await this.detectFreqStable(3000);
    this.e.micOff();
    if (this.aborted) return 0;
    this.e.setFreq(f);
    this.ui.freq(f, true);
    return f;
  }

  async coarseSweep() {
    this.state = 'coarse';
    this.ui.ring('sweep');
    this.ui.stage('위상 회전 중 — 소음이 가장 작아지는 순간 [지금 조용함]');
    this.ui.tapButton(true);
    this.e.applyMaster(VOL);
    const degPerTick = 0.9; // 9°/s → 40초 1회전
    let deg = this.e.phaseDeg;
    this.sweepTimer = setInterval(() => {
      if (this.paused) return;
      deg = (deg + degPerTick) % 360;
      this.e.setPhase(deg);
      this.ui.phase(deg);
    }, 100);
    await this.waitTap();
    this.stopSweep();
    if (this.aborted) return 0;
    const picked = (this.e.phaseDeg - 4.5 + 360) % 360; // 반응지연 보정
    this.e.setPhase(picked); this.ui.phase(picked);
    return picked;
  }

  async fineSweep(center) {
    this.state = 'fine';
    this.ui.stage('미세 조정 — 다시 가장 조용한 순간 [지금 조용함]');
    this.ui.tapButton(true);
    let t = 0;
    this.sweepTimer = setInterval(() => {
      if (this.paused) return;
      t += 0.1;
      const deg = (center + 25 * Math.sin(2 * Math.PI * t / 12) + 360) % 360;
      this.e.setPhase(deg); this.ui.phase(deg);
    }, 100);
    await this.waitTap();
    this.stopSweep();
    if (this.aborted) return;
    const locked = (this.e.phaseDeg - 2 + 360) % 360;
    this.e.setPhase(locked); this.ui.phase(locked);
    this.ui.tapButton(false);
    this.state = 'hold';
    this.ui.ring('hold');
    this.ui.stage('고정 완료 — 재생 유지 중. 음량은 측면 버튼으로.');
    this.ui.status('험 상쇄 중: ' + this.e.lockedFreq.toFixed(1) + ' Hz · 위상 ' + locked.toFixed(0) + '°');
  }

  async holdLoop() {
    while (this.running && !this.aborted) {
      for (let i = 0; i < 900 && this.running && !this.aborted; i++) {
        await sleep(100);
        if (this.paused) i = 0;
      }
      if (!this.running || this.aborted || this.paused) continue;
      const oldF = this.e.lockedFreq;
      const f = await this.measureFreq('주파수 재확인 (잠깐 무음)');
      if (!f) break;
      if (Math.abs(f - oldF) > 3) {
        this.ui.status('소음 변화 감지 — 위상 재캘리브레이션');
        const c = await this.coarseSweep();
        if (this.aborted) break;
        await this.fineSweep(c);
      } else {
        this.e.setFreq(oldF * 0.5 + f * 0.5);
        this.e.applyMaster(this.paused ? 0 : VOL);
        this.state = 'hold';
        this.ui.ring('hold');
        this.ui.stage('고정 유지 — 재생 중');
      }
    }
  }

  async runCancel() {
    this.mode = 'cancel';
    const f = await this.measureFreq();
    if (!f || this.aborted) return;
    const c = await this.coarseSweep();
    if (this.aborted) return;
    await this.fineSweep(c);
    if (this.aborted) return;
    await this.holdLoop();
  }

  // ================= 기능테스트 =================
  async runDemo() {
    this.mode = 'demo'; this.state = 'demo';
    const psi = Math.floor(Math.random() * 360);
    this.e.setFreq(60);
    this.ui.freq(60, true);
    this.e.startFakeHum(psi, 0.4);
    this.e.applyMaster(0);
    this.ui.status('기능테스트: 가짜 웅— 소리를 캘리브레이션으로 없애보세요');
    const c = await this.coarseSweep();
    if (this.aborted) return;
    await this.fineSweep(c);
    if (this.aborted) return;
    const ideal = (psi + 180) % 360;
    let err = Math.abs(this.e.phaseDeg - ideal);
    err = Math.min(err, 360 - err);
    const pass = err <= 20;
    this.ui.status('테스트 결과: 위상 오차 ' + err.toFixed(0) + '° — '
      + (pass ? '✅ 통과 (상쇄 원리·조작 검증)' : '재시도 권장'));
    this.ui.stage(pass ? '험이 거의 사라졌다면 정상입니다. [종료] 후 실전 사용.'
      : '조용해지는 순간을 더 정확히 노려 탭하세요.');
  }

  teardownTimers() {
    this.stopSweep();
    if (this.maskTimer) { clearTimeout(this.maskTimer); this.maskTimer = null; }
  }
}
