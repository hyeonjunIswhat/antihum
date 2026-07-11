// app.js — 엔트리: 모드 전환 / 수명주기 / wake lock
import { AudioEngine } from './engine.js';
import { AutoPipeline, VOL } from './pipeline.js';
import { ui } from './ui.js';

let engine = null, pipe = null, wakeLock = null;

async function boot(mode) {
  ui.error('');
  engine = new AudioEngine();
  await engine.startOutput();
  pipe = new AutoPipeline(engine, ui);
  pipe.running = true;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  ui.screen(mode);
}

async function startMask() {
  try {
    await boot('mask');
    pipe.maskLevel = parseFloat(ui.els.lvl.value);
    await pipe.runMask(ui.selectedMinutes());
  } catch (e) { ui.error('오류: ' + e.message + ' — 마이크 권한 확인'); stop(); }
}

async function startCancel() {
  try {
    await boot('cancel');
    await pipe.runCancel();
  } catch (e) { ui.error('오류: ' + e.message + ' — 마이크 권한 확인'); stop(); }
}

async function startDemo() {
  try {
    await boot('cancel'); // 화면 구성은 상쇄와 동일
    await pipe.runDemo();
  } catch (e) { ui.error('오류: ' + e.message); stop(); }
}

function pause() {
  if (!pipe || !pipe.running) return;
  pipe.paused = !pipe.paused;
  if (pipe.mode === 'mask') engine.setMaskLevel(pipe.paused ? 0 : pipe.maskLevel);
  else engine.applyMaster(pipe.paused ? 0 : VOL);
  ui.paused(pipe.paused);
  ui.status(pipe.paused ? '대기 중 — 출력 정지, 설정 유지' : '재개');
}

function stop() {
  if (pipe) { pipe.aborted = true; pipe.running = false; pipe.teardownTimers(); pipe.tap(); }
  if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
  if (engine) engine.teardown();
  engine = null; pipe = null;
  ui.screen('idle');
  ui.status('종료됨 — 모드를 선택하세요');
}

window.addEventListener('DOMContentLoaded', () => {
  ui.init();
  ui.onTimerEnd = stop;
  ui.els.maskBtn.addEventListener('click', startMask);
  ui.els.cancelBtn.addEventListener('click', startCancel);
  ui.els.demoBtn.addEventListener('click', startDemo);
  ui.els.tapBtn.addEventListener('click', () => pipe && pipe.tap());
  ui.els.pauseBtn.addEventListener('click', pause);
  ui.els.stopBtn.addEventListener('click', stop);
  ui.els.lvl.addEventListener('input', () => {
    const v = parseFloat(ui.els.lvl.value);
    ui.els.lvlRO.textContent = Math.round(v * 100) + '%';
    if (pipe) pipe.setMaskLevel(v);
  });
  ui.chips.forEach(c => c.addEventListener('click', () => {
    ui.chips.forEach(x => x.classList.remove('sel'));
    c.classList.add('sel');
  }));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
