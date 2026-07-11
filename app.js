// app.js — 엔트리: 모드 전환 / 수명주기 / wake lock
import { AudioEngine } from './engine.js';
import { AutoPipeline, VOL } from './pipeline.js';
import { ui } from './ui.js';

let engine = null, pipe = null, wakeLock = null;
let watchdog = null, lastVitals = '', beatCount = 0;

function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!engine || !engine.ctx || !pipe) return;
    const v = engine.vitals();
    const line = '오디오 ' + v.ctx + ' · 재생요소 ' + v.el + ' · 출력레벨 ' + v.lvl.toFixed(2) + ' · 마이크 ' + v.mic;
    const shouldPlay = v.lvl > 0.01 && !pipe.paused && v.mic === 'OFF';
    const bad = shouldPlay && (v.ctx !== 'running' || v.el === '일시정지');
    if (bad) {
      engine.recover();
      ui.log('⚠️ 출력 이상 감지 [' + line + '] → 자동 복구 시도');
    } else if (line !== lastVitals) {
      ui.log('상태 변화: ' + line);
    } else if (++beatCount % 15 === 0) {
      ui.log('정상 동작 중: ' + line);   // 30초마다 생존 신호
    }
    lastVitals = line;
  }, 2000);
}
function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }

async function boot(mode) {
  ui.error('');
  engine = new AudioEngine();
  await engine.startOutput();
  pipe = new AutoPipeline(engine, ui);
  pipe.running = true;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  ui.screen(mode);
  startWatchdog();
  ui.log && ui.log('세션 시작 — 워치독 가동(2초 주기 감시·자동복구)');
}

async function startSmart() {
  try {
    await boot('mask');
    pipe.maskLevel = parseFloat(ui.els.lvl.value);
    await pipe.runSmart(ui.selectedMinutes());
  } catch (e) { ui.error('오류: ' + e.message + ' — 마이크 권한 확인'); stop(); }
}

async function acceptHum() {
  if (!pipe) return;
  try {
    if (pipe.suggestAction === 'refine') await pipe.manualRefine();
    else if (pipe.state === 'hold') pipe.addMask();
    else await pipe.addCancel();
  } catch (e) { ui.error('오류: ' + e.message); }
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
  engine.setMaskLevel(pipe.paused ? 0 : pipe.maskLevel);
  engine.applyMaster(pipe.paused ? 0 : (pipe.mode === 'cancel' ? pipe.cancelVol : 0));
  ui.paused(pipe.paused);
  ui.status(pipe.paused ? '대기 중 — 출력 정지, 설정 유지' : '재개');
}

function stop() {
  stopWatchdog();
  if (pipe) { pipe.aborted = true; pipe.running = false; pipe.teardownTimers(); pipe.tap(); }
  if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
  if (engine) engine.teardown();
  engine = null; pipe = null;
  ui.screen('idle');
  ui.status('멈췄습니다 — [지금 조용하게]로 다시 시작');
}

window.addEventListener('DOMContentLoaded', () => {
  ui.init();
  ui.onTimerEnd = stop;
  ui.els.maskBtn.addEventListener('click', startSmart);
  ui.els.humSuggest.addEventListener('click', acceptHum);
  ui.els.demoBtn.addEventListener('click', startDemo);
  ui.els.tapBtn.addEventListener('click', () => pipe && pipe.tap());
  ui.els.pauseBtn.addEventListener('click', pause);
  ui.els.stopBtn.addEventListener('click', stop);
  ui.els.beepBtn.addEventListener('click', () => {
    if (!engine || !engine.ctx) { ui.log && ui.log('소리 확인: 엔진 꺼짐 — [지금 조용하게]로 시작 후 사용'); return; }
    const st = engine.beep();
    ui.log && ui.log('🔔 확인음 재생 시도 — 오디오 상태: ' + st + ' (삐가 들려야 정상)');
  });
  ui.els.resetBtn.addEventListener('click', () => {
    try { localStorage.removeItem('antihum_profile'); } catch (_) {}
    ui.log && ui.log('학습값 삭제됨 — 다음 실행은 처음부터 캘리브레이션');
  });
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
