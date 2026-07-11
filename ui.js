// ui.js — DOM 바인딩 (v2: 탭 버튼 추가, 잔류 게이지 제거 — 귀가 센서)
const $ = id => document.getElementById(id);

export const ui = {
  els: {},
  init() {
    for (const id of ['status','freq','flabel','err','stage','phaseRO',
      'startBtn','tapBtn','pauseBtn','stopBtn']) this.els[id] = $(id);
  },
  status(t){ this.els.status.textContent = t; },
  stage(t){ this.els.stage.textContent = t; },
  error(html){ this.els.err.innerHTML = html; },
  freq(f, locked){
    this.els.freq.textContent = f > 0 ? f.toFixed(1) + ' Hz' : '— Hz';
    this.els.freq.classList.toggle('on', !!locked);
    this.els.flabel.textContent = locked ? '타겟 고정' : '타겟 주파수';
  },
  phase(d){ this.els.phaseRO.textContent = d.toFixed(0) + '°'; },
  tapButton(show){
    this.els.tapBtn.style.display = show ? 'block' : 'none';
  },
  reset(){
    this.freq(0, false);
    this.els.phaseRO.textContent = '—';
    this.stage('');
  },
  buttons(running, paused){
    this.els.startBtn.disabled = running;
    this.els.pauseBtn.disabled = !running;
    this.els.stopBtn.disabled = !running;
    this.els.pauseBtn.textContent = paused ? '재개' : '대기';
  }
};
