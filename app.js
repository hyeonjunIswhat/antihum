// app.js — v2: 시작 / 지금 조용함 / 대기 / 종료
import { AudioEngine } from './engine.js';
import { AutoPipeline, VOL } from './pipeline.js';
import { ui } from './ui.js';

let engine = null, pipe = null, wakeLock = null;

async function start() {
  ui.error('');
  try {
    engine = new AudioEngine();
    await engine.startOutput();          // 마이크 없이 출력 그래프만 (정상 재생 세션)
    pipe = new AutoPipeline(engine, ui);
    pipe.running = true;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    ui.buttons(true, false);
    ui.status('시작 — 소음 측정부터');
    await pipe.run();
  } catch (e) {
    ui.error('오류: ' + e.message + ' — 마이크 권한을 확인하세요.');
    stop();
  }
}

function tap() { if (pipe) pipe.tap(); }

function pause() {
  if (!pipe || !pipe.running) return;
  pipe.paused = !pipe.paused;
  engine.applyMaster(pipe.paused ? 0 : VOL);
  ui.buttons(true, pipe.paused);
  ui.status(pipe.paused ? '대기 중 — 출력 정지, 설정 유지' : '재개');
}

function stop() {
  if (pipe) { pipe.aborted = true; pipe.running = false; pipe.stopSweep(); pipe.tap(); }
  if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
  if (engine) engine.teardown();
  engine = null; pipe = null;
  ui.buttons(false, false);
  ui.tapButton(false);
  ui.reset();
  ui.status('종료 — 다시 시작하려면 [시작]');
}

window.addEventListener('DOMContentLoaded', () => {
  ui.init();
  ui.els.startBtn.addEventListener('click', start);
  ui.els.tapBtn.addEventListener('click', tap);
  ui.els.pauseBtn.addEventListener('click', pause);
  ui.els.stopBtn.addEventListener('click', stop);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
