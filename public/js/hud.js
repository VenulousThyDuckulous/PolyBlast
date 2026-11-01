/**
 * DOM HUD and minimap. All text goes in through textContent — names are user-supplied, so they must
 * never be interpolated as HTML.
 */

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = $('hud');
    this.hpFill = $('hp-fill');
    this.armorFill = $('armor-fill');
    this.hpText = $('hp-text');
    this.killsText = $('kills-text');
    this.magEl = $('ammo-mag');
    this.reserveEl = $('ammo-reserve');
    this.weaponName = $('weapon-name');
    this.slots = [...document.querySelectorAll('#slots .slot')];
    this.reloadBar = $('reload-bar');
    this.reloadFill = $('reload-fill');
    this.aliveEl = $('alive-count');
    this.zoneState = $('zone-state');
    this.zoneTimer = $('zone-timer');
    this.zoneHint = $('zone-hint');
    this.prompt = $('prompt');
    this.promptText = $('prompt-text');
    this.toastEl = $('toast');
    this.feedEl = $('killfeed');
    this.bannerEl = $('banner');
    this.vignette = $('vignette');
    this.hitmarkerEl = $('hitmarker');
    this.dead = $('dead');
    this.deadKiller = $('dead-killer');
    this.deadDetail = $('dead-detail');
    this.results = $('results');
    this.resultsEyebrow = $('results-eyebrow');
    this.winnerName = $('winner-name');
    this.winnerDetail = $('winner-detail');
    this.countdown = $('countdown');
    this.countdownNumber = $('countdown-number');

    this.minimap = $('minimap');
    this.mapCtx = this.minimap.getContext('2d');
    this.hurtTimer = 0;
    this.deathShown = false;
    this.resultsShown = false;
    this.toasts = [];
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  update(view, dt) {
    const you = view.you;
    if (!you) return;
    const rules = view.config.player;

    // ---- vitals
    const hpPct = Math.max(0, Math.min(100, (you.hp / rules.maxHp) * 100));
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background = hpPct < 30 ? 'linear-gradient(90deg,#a3242f,#ff5d6c)' : '';
    this.hpText.textContent = String(Math.max(0, Math.round(you.hp)));
    this.armorFill.style.width = `${Math.max(0, Math.min(100, (you.armor / rules.maxArmor) * 100))}%`;
    this.killsText.textContent = `${you.kills} kill${you.kills === 1 ? '' : 's'}`;

    // ---- weapon
    const slots = you.slots || [null, null];
    this.slots.forEach((el, i) => {
      const s = slots[i];
      const nameEl = el.querySelector('.slot-name');
      nameEl.textContent = s ? s.kind.toUpperCase() : '—';
      el.classList.toggle('active', you.slot === i && !!s);
      el.classList.toggle('empty', !s);
    });
    this.weaponName.textContent = you.held ? view.config.weapons[you.held].label : 'Unarmed';
    this.magEl.textContent = String(you.mag);
    this.reserveEl.textContent = String(you.reserve);
    this.magEl.style.color = you.mag === 0 ? 'var(--danger)' : '';

    if (you.reloading) {
      this.reloadBar.classList.add('active');
      this.reloadFill.style.width = `${Math.round((1 - you.reload) * 100)}%`;
    } else {
      this.reloadBar.classList.remove('active');
      this.reloadFill.style.width = '0%';
    }

    // ---- match state
    this.aliveEl.textContent = String(view.alive);
    const z = view.zone;
    if (z.mode === 'close') {
      this.zoneState.textContent = 'Circle closing';
      this.zoneState.classList.add('closing');
    } else if (z.mode === 'final') {
      this.zoneState.textContent = 'Final circle';
      this.zoneState.classList.add('closing');
    } else {
      const next = view.config.zonePhases[z.index];
      this.zoneState.textContent = next ? `Hold · ${z.dps} dmg/s` : 'Final circle';
      this.zoneState.classList.remove('closing');
    }
    this.zoneTimer.textContent = z.mode === 'final' ? '—' : `${Math.ceil(z.timer)}s`;

    const distFromCenter = Math.hypot(view.me.x - z.x, view.me.z - z.z);
    this.zoneHint.classList.toggle('hidden', !(distFromCenter > z.r && view.me.alive));

    // ---- interaction prompt
    if (view.me.alive && view.nearbyLoot) {
      this.prompt.classList.remove('hidden');
      this.promptText.textContent = view.nearbyLoot;
    } else {
      this.prompt.classList.add('hidden');
    }

    // ---- countdown banner
    if (view.phase === 'countdown') {
      this.countdown.classList.remove('hidden');
      this.countdownNumber.textContent = String(Math.max(1, Math.ceil(view.countdown)));
    } else {
      this.countdown.classList.add('hidden');
    }

    // ---- death / results overlays
    const isDead = !you.alive && view.phase === 'live';
    if (isDead && !this.deathShown) this.showDeath(view);
    if (!isDead && this.deathShown) this.hideDeath();

    if (view.phase === 'over' && !this.resultsShown) this.showResults(view);
    if (view.phase !== 'over' && this.resultsShown) this.hideResults();

    // ---- damage vignette fade
    if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
      if (this.hurtTimer <= 0) this.vignette.classList.remove('hurt');
    }

    this.drawMinimap(view);
  }

  showDeath(view) {
    this.deathShown = true;
    const killer = view.players.find((p) => p.id === view.spectateId);
    this.deadKiller.textContent = killer ? killer.n : 'The circle';
    this.deadKiller.style.color = killer ? killer.c : 'var(--zone)';
    this.deadDetail.textContent = killer
      ? 'Spectating your killer. Stay in the circle until the next drop.'
      : 'The ring took you. Watch how the rest of the match plays out.';
    this.dead.classList.remove('hidden');
  }

  hideDeath() {
    this.deathShown = false;
    this.dead.classList.add('hidden');
  }

  showResults(view) {
    this.resultsShown = true;
    const w = view.winner;
    const mine = w && w.id === view.me.id;
    this.resultsEyebrow.textContent = mine ? 'Victory' : 'Match over';
    this.winnerName.textContent = w ? (mine ? 'You win' : `${w.name} wins`) : 'No survivors';
    this.winnerName.style.color = mine ? 'var(--accent)' : w ? w.color : 'var(--text)';
    this.winnerDetail.textContent = w
      ? `${w.kills} kill${w.kills === 1 ? '' : 's'} · next match dropping shortly`
      : 'The circle claimed everyone. Next match dropping shortly';
    this.results.classList.remove('hidden');
  }

  hideResults() {
    this.resultsShown = false;
    this.results.classList.add('hidden');
  }

  hitmarker(kill = false) {
    const el = this.hitmarkerEl;
    el.classList.remove('show');
    el.classList.toggle('kill', kill);
    // Force a reflow so the animation restarts on rapid hits.
    void el.offsetWidth;
    el.classList.add('show');
  }

  hurt() {
    this.vignette.classList.add('hurt');
    this.hurtTimer = 0.35;
  }

  addKill(event) {
    const row = document.createElement('div');
    row.className = 'feed-row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = event.kname;
    k.style.color = event.kcolor;
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = event.w === 'zone' ? 'the circle' : event.head ? 'headshot' : (event.w || '');
    const v = document.createElement('span');
    v.className = 'k';
    v.textContent = event.vname;
    v.style.color = event.vcolor;
    row.append(k, w, v);
    if (event.killer && event.killer === this.selfId) row.classList.add('mine');
    this.feedEl.append(row);
    if (this.feedEl.children.length > 5) this.feedEl.firstChild.remove();
    setTimeout(() => row.remove(), 6500);
  }

  setSelfId(id) {
    this.selfId = id;
  }

  toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    this.toastEl.append(el);
    if (this.toastEl.children.length > 3) this.toastEl.firstChild.remove();
    setTimeout(() => el.remove(), 1800);
  }

  banner(text, ms = 2200) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove('hidden');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.bannerEl.classList.add('hidden'), ms);
  }

  clearFeed() {
    this.feedEl.replaceChildren();
    this.toastEl.replaceChildren();
  }

  drawMinimap(view) {
    const ctx = this.mapCtx;
    const size = this.minimap.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.minimap.width !== Math.round(180 * dpr)) {
      this.minimap.width = Math.round(180 * dpr);
      this.minimap.height = Math.round(180 * dpr);
    }
    const w = this.minimap.width;
    const half = view.arenaHalf;
    const scale = w / (half * 2);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = 'rgba(9,13,21,0.72)';
    ctx.fillRect(0, 0, w, w);

    const toX = (x) => (x + half) * scale;
    const toY = (z) => (z + half) * scale;

    // Ground grid
    ctx.strokeStyle = 'rgba(120,150,190,0.12)';
    ctx.lineWidth = Math.max(1, dpr * 0.7);
    for (let g = -half; g <= half; g += half / 4) {
      ctx.beginPath();
      ctx.moveTo(toX(g), 0);
      ctx.lineTo(toX(g), w);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, toY(g));
      ctx.lineTo(w, toY(g));
      ctx.stroke();
    }

    const z = view.zone;

    // Next circle
    if (z.mode === 'close' && z.tr < z.r) {
      ctx.strokeStyle = 'rgba(223,233,245,0.45)';
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.arc(toX(z.tx), toY(z.tz), z.tr * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current circle
    ctx.strokeStyle = z.mode === 'close' ? 'rgba(255,180,87,0.95)' : 'rgba(88,199,255,0.9)';
    ctx.lineWidth = Math.max(1.4, dpr * 1.2);
    ctx.beginPath();
    ctx.arc(toX(z.x), toY(z.z), Math.max(1, z.r * scale), 0, Math.PI * 2);
    ctx.stroke();

    // Loot (faint, so the map stays readable)
    ctx.fillStyle = 'rgba(255,209,102,0.35)';
    for (const item of view.loot) {
      if (item.k !== 'weapon') continue;
      ctx.fillRect(toX(item.x) - dpr, toY(item.z) - dpr, dpr * 1.6, dpr * 1.6);
    }

    // Players
    for (const p of view.players) {
      if (!p.al) continue;
      const px = toX(p.x);
      const py = toY(p.z);
      if (p.id === view.me.id) {
        // Self: a little heading triangle.
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-p.yaw);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(0, -4.2 * dpr);
        ctx.lineTo(3 * dpr, 3.4 * dpr);
        ctx.lineTo(-3 * dpr, 3.4 * dpr);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(px, py, (p.b ? 2 : 2.6) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
