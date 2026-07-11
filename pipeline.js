// pipeline.js — 세션 로직: 마스킹 / 험 상쇄 / 기능테스트

import { detectFreqOnce, bandLevels, tonalPeak, tonalPeakInRange, sleep, median } from './dsp.js';

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
    this.cancelVol = 0.5;    // 스윕 볼륨 = 진단음과 동일 (저음 약한 스피커 대응)
    this.lastShape = null;
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
    const fs = [], proms = [], pfs = [];
    while (performance.now() - t0 < ms) {
      const lv = bandLevels(this.e.analyser, this.e.ctx.sampleRate, BANDS);
      for (let i = 0; i < 4; i++) acc[i] += lv[i];
      fs.push(detectFreqOnce(this.e.analyser, this.e.ctx.sampleRate));
      // 상쇄 타겟은 스피커 재생 가능 대역(150Hz+)에서만 고른다 — 초저역은 어떤 스피커도 못 냄
      const hiTp = tonalPeakInRange(this.e.analyser, this.e.ctx.sampleRate, 150, 500);
      const loTp = tonalPeakInRange(this.e.analyser, this.e.ctx.sampleRate, 40, 150);
      proms.push(hiTp.prom); pfs.push(hiTp.freq);
      this._loProm = loTp.prom; this._loFreq = loTp.freq;
      n++;
      await sleep(200);
      if (this.aborted) return null;
    }
    return { bands: acc.map(v => v / n), freq: median(fs),
             tonalFreq: median(pfs), prom: median(proms),
             loFreq: this._loFreq, loProm: this._loProm };
  }

  // ================= 원버튼 스마트 플로우 =================
  // 측정 → 맞춤 마스킹 자동 시작 → 저주파 웅— 성분 강하면 험 상쇄 '제안'
  async runSmart(minutes) {
    this.mode = 'mask'; this.state = 'measure';
    this.ui.ring('measure');
    this.ui.stage('소음을 3초 듣는 중…');
    this.e.applyMaster(0);
    await this.e.micOn();
    await sleep(400);
    const m = await this.measureSpectrum(2600);
    this.e.micOff();
    if (!m || this.aborted) return;

    const mean = m.bands.reduce((a, b) => a + b, 0) / 4;
    this.lastShape = m.bands.map(v => Math.max(-10, Math.min(10, (v - mean) * 0.8)));

    // ---- 판정: 재생 가능 대역(150~500Hz)에 뚜렷한 피크가 있어야만 상쇄 ----
    if (m.prom >= 10 && m.tonalFreq >= 150 && m.tonalFreq <= 500) {
      if (this.ui.screen) this.ui.screen('cancel');
      this.mode = 'cancel';
      this.humFreq = m.tonalFreq;
      this.e.setFreq(m.tonalFreq);
      this.ui.freq(m.tonalFreq, true);
      this.ui.status('웅— 소리(' + m.tonalFreq.toFixed(0) + 'Hz)가 주된 소음 — 역위상으로 지웁니다');
      // 3단 진단음: 높은 삐(880) → 중간 삐(440) → 타겟 웅 — 어디까지 들리는지로 원인 판별
      this.ui.stage('진단음 3개: 삐(높음) → 삐(중간) → 웅(타겟) — 몇 개 들리는지 세어보세요');
      for (const [f, ms] of [[880, 600], [440, 600], [m.tonalFreq, 1400]]) {
        this.e.setFreq(f);
        this.e.applyMaster(0.5);
        if (f === m.tonalFreq) {
          // 웅 소리를 내는 동안 위상 한 바퀴 — 끊기지 않아야 위상 회로 정상
          for (let d = 0; d <= 360; d += 30) { this.e.setPhase(d); await sleep(ms / 13); }
        } else {
          await sleep(ms);
        }
        this.e.applyMaster(0);
        await sleep(300);
        if (this.aborted) return;
      }
      this.e.setFreq(m.tonalFreq);
      this.ui.error('진단: 웅 소리가 중간에 끊겼다면 알려주세요(위상 회로 문제). 삐만 들리고 웅이 전혀 안 들리면 = 스피커 저음 한계. '
        + '3개 전부 안 들리면 = 출력 버그(알려주세요). 3개 다 들리면 = 정상, 계속 진행하세요.');
      const c = await this.coarseSweep();
      if (this.aborted) return;
      await this.fineSweep(c);
      if (this.aborted) return;
      await this.volSweep();
      if (this.aborted) return;
      this.finishCancel(minutes);
      return;
    }

    // ---- 상쇄 불가(광대역이거나 핵심이 초저역) → 맞춤 마스킹 ----
    if (m.loProm >= 12 && m.loFreq < 150) {
      this.ui.error('주 소음(' + m.loFreq.toFixed(0) + 'Hz)은 스피커가 재생할 수 없는 초저역이라 상쇄가 물리적으로 불가합니다. 마스킹으로 전환합니다. 이 성분을 지우려면 ANC 헤드폰이 정답입니다.');
    }
    this.e.startMasking(this.lastShape, this.maskLevel);
    this.state = 'mask';
    this.ui.ring('mask');
    this.ui.freq(m.freq, false);
    this.ui.stage('소음의 결에 맞춘 소리로 덮는 중입니다');
    this.ui.status('조용하게 만드는 중' + (minutes ? ' · ' + minutes + '분 후 자동 종료' : ''));
    this.armTimer(minutes);
  }

  armTimer(minutes) {
    if (!minutes) return;
    this.maskTimer = setTimeout(() => {
      this.e.setMaskLevel(0);
      this.e.applyMaster(0);
      setTimeout(() => this.ui.onTimerEnd && this.ui.onTimerEnd(), 2000);
    }, minutes * 60000);
  }

  // 음량 캘리브레이션: 안티톤 크기를 천천히 오르내림 — 가장 조용한 순간 탭
  async volSweep() {
    this.state = 'vol';
    this.ui.stage('음량 맞추는 중 — 가장 조용한 순간 한 번 더 [지금 조용함]');
    this.ui.tapButton(true);
    let t = 0;
    this.sweepTimer = setInterval(() => {
      if (this.paused) return;
      t += 0.1;
      const v = 0.45 + 0.4 * Math.sin(2 * Math.PI * t / 14); // 0.05~0.85, 14초 주기
      this.cancelVol = v;
      this.e.applyMaster(v);
    }, 100);
    await this.waitTap();
    this.stopSweep();
    if (this.aborted) return;
    this.e.applyMaster(this.cancelVol);
    this.ui.tapButton(false);
  }

  finishCancel(minutes) {
    this.state = 'hold';
    this.ui.ring('hold');
    this.ui.stage('웅— 상쇄 고정 완료 — 재생 유지 중');
    this.ui.status('상쇄 동작 중: ' + this.e.lockedFreq.toFixed(1) + ' Hz');
    this.ui.showHumSuggest(0, '잔여 소음까지 부드러운 소리로 덮기 (마스킹 추가) →');
    this.armTimer(minutes);
  }

  // 상쇄 후 마스킹 추가 (제안 수락)
  addMask() {
    this.ui.hideHumSuggest();
    if (this.lastShape) this.e.startMasking(this.lastShape, this.maskLevel);
    this.ui.ring('mask');
    this.ui.stage('웅— 상쇄 + 맞춤 마스킹 동시 재생 중');
  }

  // (마스킹 중) 제안 수락 → 마스킹 잠시 멈추고 상쇄 캘리브레이션 → 동시 재생
  async addCancel() {
    this.ui.hideHumSuggest();
    this.e.setMaskLevel(0);
    this.e.setFreq(this.humFreq);
    this.ui.freq(this.humFreq, true);
    this.ui.stage('웅— 소리에 집중하세요');
    await sleep(1200);
    const c = await this.coarseSweep();
    if (this.aborted) return;
    await this.fineSweep(c);
    if (this.aborted) return;
    await this.volSweep();
    if (this.aborted) return;
    this.e.setMaskLevel(this.maskLevel);
    this.ui.ring('mask');
    this.ui.stage('웅— 상쇄 + 맞춤 마스킹 동시 재생 중');
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
    this.e.applyMaster(this.cancelVol);
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
        this.e.applyMaster(this.paused ? 0 : this.cancelVol);
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
