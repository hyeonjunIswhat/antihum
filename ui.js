// ui.js — DOM 바인딩 + 링 상태
const $ = id => document.getElementById(id);

export const ui = {
  els: {}, onTimerEnd: null,
  init() {
    for (const id of ['status','freq','flabel','err','stage','phaseRO','ring','ringDot',
      'maskBtn','demoBtn','humSuggest','tapBtn','pauseBtn','stopBtn',
      'modes','runBtns','maskCtrl','lvl','lvlRO']) this.els[id] = $(id);
    this.chips = Array.from(document.querySelectorAll('.chip'));
  },
  status(t){ this.els.status.textContent = t; },
  stage(t){ this.els.stage.textContent = t; },
  error(html){ this.els.err.innerHTML = html; },
  freq(f, locked){
    this.els.freq.textContent = f > 0 ? f.toFixed(1) : '—';
    this.els.freq.classList.toggle('on', !!locked);
    this.els.flabel.textContent = f > 0 ? 'Hz' : 'READY';
  },
  reduction(db){
    if (this.els.redRO) this.els.redRO.textContent = (db > 0 ? '-' + db.toFixed(1) : '0.0') + ' dB';
  },
  phase(d){
    this.els.phaseRO.textContent = d == null ? '' : '위상 ' + d.toFixed(0) + '°';
    this.els.ringDot.style.transform = 'rotate(' + (d || 0) + 'deg) translateY(-105px)';
  },
  ring(state){ // 'idle'|'measure'|'mask'|'sweep'|'hold'
    this.els.ring.className = 'ring' + (state && state !== 'idle' ? ' ' + state : '');
  },
  tapButton(show){ this.els.tapBtn.style.display = show ? 'block' : 'none'; },
  tapLabel(t){ this.els.tapBtn.textContent = t; },
  showHumSuggest(f, text){
    if (text) this.els.humSuggest.innerHTML = '💡 ' + text;
    this.els.humSuggest.style.display = 'block';
  },
  hideHumSuggest(){ this.els.humSuggest.style.display = 'none'; },
  screen(mode){ // 'idle' | 'mask' | 'cancel'
    const running = mode !== 'idle';
    this.els.modes.style.display = running ? 'none' : 'grid';
    this.els.runBtns.style.display = running ? 'grid' : 'none';
    this.els.maskCtrl.style.display = mode === 'mask' ? 'block' : 'none';
    this.els.demoBtn.disabled = running;
    if (!running) {
      this.ring('idle'); this.freq(0, false); this.phase(null);
      this.stage(''); this.tapButton(false); this.hideHumSuggest();
      this.els.pauseBtn.textContent = '대기';
    }
  },
  paused(p){ this.els.pauseBtn.textContent = p ? '재개' : '대기'; },
  selectedMinutes(){
    const sel = this.chips.find(c => c.classList.contains('sel'));
    return sel ? parseInt(sel.dataset.min, 10) : 0;
  }
};
