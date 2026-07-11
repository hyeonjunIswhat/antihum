// pipeline.js — v2 시분할 + 귀 캘리브레이션 상태머신
// MEASURE(마이크) → COARSE 위상 회전(귀+탭) → FINE 왕복(귀+탭) → HOLD(재생 유지, 주기적 주파수 재확인)

import { detectFreqOnce, sleep, median } from './dsp.js';

export const VOL = 0.4; // 재생 볼륨(고정) — 실제 음량은 측면 볼륨 버튼으로 조절

export class AutoPipeline {
  constructor(engine, ui) {
    this.e = engine; this.ui = ui;
    this.running = false; this.paused = false; this.aborted = false;
    this.state = 'idle';        // idle|measure|coarse|fine|hold
    this.tapResolve = null;      // [지금 조용함] 탭 대기
    this.sweepTimer = null;
  }

  // ---- 마이크 측정 (출력 무음 상태에서만) ----
  async detectFreqStable(ms) {
    const t0 = performance.now(); const fs = [];
    while (performance.now() - t0 < ms) {
      fs.push(detectFreqOnce(this.e.analyser, this.e.ctx.sampleRate));
      await sleep(200);
      if (this.aborted) return 0;
    }
    return median(fs);
  }

  async measureFreq(label) {
    this.state = 'measure';
    this.ui.stage(label || '① 소음 주파수 측정 중 (마이크 3초)');
    this.ui.tapButton(false);
    this.e.applyMaster(0);
    await this.e.micOn();
    await sleep(400);
    const f = await this.detectFreqStable(3000);
    this.e.micOff();               // 반드시 해제 → 재생 세션 복귀
    if (this.aborted) return 0;
    this.e.setFreq(f);
    this.ui.freq(f, true);
    this.ui.status('타겟 ' + f.toFixed(1) + ' Hz · 마이크 해제됨(측정 시에만 켜짐)');
    return f;
  }

  waitTap() {
    return new Promise(res => { this.tapResolve = res; });
  }
  tap() {
    if (this.tapResolve) { const r = this.tapResolve; this.tapResolve = null; r(); }
  }

  stopSweep() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  // ---- 거친 스캔: 360°를 40초에 1회전, 탭으로 선택 ----
  async coarseSweep() {
    this.state = 'coarse';
    this.ui.stage('② 위상 회전 중 — 소음이 가장 작아지는 순간 [지금 조용함]을 누르세요');
    this.ui.tapButton(true);
    this.e.applyMaster(VOL);
    const degPerSec = 9; // 360°/40s
    let deg = this.e.phaseDeg;
    this.sweepTimer = setInterval(() => {
      if (this.paused) return;
      deg = (deg + degPerSec / 10) % 360;
      this.e.setPhase(deg);
      this.ui.phase(deg);
    }, 100);
    await this.waitTap();
    this.stopSweep();
    if (this.aborted) return 0;
    // 반응 지연 보정: 사람 반응 ~0.5초 → 4.5° 되돌림
    const picked = (this.e.phaseDeg - 4.5 + 360) % 360;
    this.e.setPhase(picked);
    this.ui.phase(picked);
    return picked;
  }

  // ---- 정밀 스캔: 선택점 ±25° 왕복(느리게), 탭으로 확정 ----
  async fineSweep(center) {
    this.state = 'fine';
    this.ui.stage('③ 미세 조정 중 — 다시 가장 조용한 순간 [지금 조용함]');
    this.ui.tapButton(true);
    let t = 0;
    this.sweepTimer = setInterval(() => {
      if (this.paused) return;
      t += 0.1;
      const offset = 25 * Math.sin(2 * Math.PI * t / 12); // 12초 주기 왕복
      const deg = (center + offset + 360) % 360;
      this.e.setPhase(deg);
      this.ui.phase(deg);
    }, 100);
    await this.waitTap();
    this.stopSweep();
    if (this.aborted) return;
    const locked = (this.e.phaseDeg - 2 + 360) % 360; // 반응 지연 소보정
    this.e.setPhase(locked);
    this.ui.phase(locked);
    this.ui.tapButton(false);
    this.state = 'hold';
    this.ui.stage('④ 고정 완료 — 재생 유지 중. 음량은 측면 볼륨 버튼으로.');
    this.ui.status('상쇄 재생 중: ' + this.e.lockedFreq.toFixed(1) + ' Hz, 위상 ' + locked.toFixed(0) + '°');
  }

  // ---- 유지: 90초마다 주파수만 재확인(짧게 마이크) ----
  async holdLoop() {
    while (this.running && !this.aborted) {
      for (let i = 0; i < 900 && this.running && !this.aborted; i++) { // 90초
        await sleep(100);
        if (this.paused) i = Math.min(i, 0); // 대기 중엔 카운트 정지
      }
      if (!this.running || this.aborted || this.paused) continue;
      const oldF = this.e.lockedFreq;
      const f = await this.measureFreq('주파수 재확인 중 (잠깐 무음)');
      if (!f) break;
      if (Math.abs(f - oldF) > 3) {
        // 소음원이 크게 바뀜 → 위상 재캘리브레이션 필요
        this.ui.status('소음 변화 감지 — 위상 다시 잡습니다');
        const c = await this.coarseSweep();
        if (this.aborted) break;
        await this.fineSweep(c);
      } else {
        this.e.setFreq(oldF * 0.5 + f * 0.5); // 미세 드리프트 보정
        this.e.applyMaster(this.paused ? 0 : VOL);
        this.state = 'hold';
        this.ui.stage('④ 고정 유지 — 재생 중');
      }
    }
  }

  async run() {
    const f = await this.measureFreq();
    if (!f || this.aborted) return;
    const c = await this.coarseSweep();
    if (this.aborted) return;
    await this.fineSweep(c);
    if (this.aborted) return;
    await this.holdLoop();
  }
}
