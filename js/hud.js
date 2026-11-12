/**
 * PANODROME — Stage 1.5 · Luxury "Invisible UI" HUD
 *
 * 92% of the viewport stays pure, unobstructed architecture. Everything else:
 *   · top-inline-start  — one compact glass pill: Room Title · Designer · Source
 *   · top-inline-end    — three 38px circular glass buttons: [🔊] [EN/فا] [⛶/reset]
 *   · bottom-centre     — routing-mode bar (Architect | Style | Room Type | Random)
 *                         above the navigation capsule (‹ name (i of n) › + hint)
 *   · transient         — collision toast ("برخورد با مانع: پیانو گرند") + radial
 *                         glass ripple at the obstacle's screen position
 *   · touch only        — analog walk joystick (inline-end edge)
 * Zero-overflow guarantee: max-widths + ellipsis everywhere (see style.css).
 */
import { i18n } from "./i18n.js";

const MODE_IDS = ["mode-architect", "mode-style", "mode-room_type", "mode-random"];
const MODES = ["architect", "style", "room_type", "random"];

export class HUD {
  constructor() {
    this.el = {};
    const camel = (s) => s.replace(/-(.)/g, (_, c) => c.toUpperCase());
    for (const id of [
      "room-pill", "room-title", "room-badge", "room-designer", "room-source",
      "view-actions", "btn-sound", "snd-on", "snd-off", "btn-lang",
      "btn-view", "btn-view-reset", "btn-view-full",
      "btn-radar",
      "mode-bar", "mode-architect", "mode-style", "mode-room_type", "mode-random",
      "nav-capsule", "nav-prev", "nav-next", "nav-name", "nav-count", "nav-hint",
      "bump-toast", "bump-label", "ripple-host",
      "joystick", "joy-base", "joy-knob",
      "wp-chip", "wp-chip-label",
      "radar-wrap", "radar", "radar-label",
      "loading", "load-fill", "load-text",
      "intro", "intro-bg", "intro-tag", "intro-sub", "btn-enter", "intro-hint", "intro-credit",
      "fade", "webgl-error",
    ]) {
      this.el[camel(id)] = document.getElementById(id);
    }
    this._onChip = null;
    this._chipRoom = null;
    this._onMode = null;
    this._mode = "architect";
    this._onSound = null;
    this._bumpTimer = null;
    this._modeTimer = null;

    this.el.wpChip?.addEventListener("click", () => this._onChip && this._onChip(this._chipRoom));
    this.el.btnSound?.addEventListener("click", () => this._onSound && this._onSound());
    this._onRadar = null;
    this.el.btnRadar?.addEventListener("click", () => this._onRadar && this._onRadar());
    for (const id of MODE_IDS) {
      this.el[camel(id)]?.addEventListener("click", () => {
        const mode = id.replace("mode-", "").replace("_", "_");
        this._onMode && this._onMode(MODES[MODE_IDS.indexOf(id)]);
      });
    }

    this._applyIntroStrings();
    i18n.onChange(() => this._applyIntroStrings());
  }

  _applyIntroStrings() {
    const t = i18n.t;
    this.el.introTag.textContent = t.tagline;
    this.el.introSub.textContent = t.intro_sub;
    this.el.introHint.textContent = t.intro_hint;
    this.el.btnEnter.querySelector("span").textContent = t.enter;
    this.el.introCredit.textContent = t.credit;
    this.el.btnLang.textContent = t.lang_btn;
    this.el.btnRadar?.setAttribute("aria-label", t.radar_btn);
    this.el.btnRadar?.setAttribute("title", t.radar_btn);
    this.el.navHint.textContent = matchMedia("(pointer: coarse)").matches ? t.hint_touch : t.hint;
    this.el.navPrev.setAttribute("aria-label", t.nav_prev);
    this.el.navNext.setAttribute("aria-label", t.nav_next);
    this.el.loadText.textContent = t.loading;
    this.el.joyBase?.setAttribute("aria-label", t.joystick);
    this._setModeLabels();
    this._setSoundTitles();
    this._setViewTitles();
    if (this._room) this.setRoom(this._room, this._idx, this._total);
  }

  _setModeLabels() {
    const t = i18n.t;
    const labels = {
      architect: t.mode_architect,
      style: t.mode_style,
      room_type: t.mode_room_type,
      random: t.mode_random,
    };
    const fulls = {
      architect: t.mode_architect_full,
      style: t.mode_style_full,
      room_type: t.mode_room_type_full,
      random: t.mode_random_full,
    };
    for (const id of MODE_IDS) {
      const mode = MODES[MODE_IDS.indexOf(id)];
      const btn = this.el[id.replace(/-(.)/g, (_, c) => c.toUpperCase())];
      if (!btn) continue;
      const span = btn.querySelector(".mode-label");
      if (span) span.textContent = labels[mode];
      btn.setAttribute("title", fulls[mode]);
      btn.setAttribute("aria-label", fulls[mode]);
      btn.classList.toggle("active", mode === this._mode);
    }
    this.el.modeBar?.setAttribute("aria-label", i18n.t.mode_bar_label);
  }

  _setSoundTitles() {
    const on = !this._muted;
    this.el.btnSound?.setAttribute("title", on ? i18n.t.sound_on : i18n.t.sound_off);
    this.el.btnSound?.setAttribute("aria-label", on ? i18n.t.sound_on : i18n.t.sound_off);
    this.el.sndOn.style.display = on ? "" : "none";
    this.el.sndOff.style.display = on ? "none" : "";
    this.el.btnSound.classList.toggle("on", on);
  }

  /* ------------------------------------------------------------ intro / load */

  initIntro(previewUrl, onEnter) {
    this.el.introBg.style.backgroundImage = `url(${previewUrl})`;
    this.el.btnEnter.addEventListener("click", onEnter, { once: true });
  }

  hideIntro() { this.el.intro.classList.add("gone"); }

  showHud() {
    // radarWrap unhides here (fixes the upgrade's hidden-radar bug: the wrap
    // kept its hud-hidden class forever, so the canvas drew invisibly)
    for (const key of ["roomPill", "viewActions", "modeBar", "navCapsule", "radarWrap"]) {
      this.el[key]?.classList.remove("hud-hidden");
    }
    if (matchMedia("(pointer: coarse)").matches) {
      document.body.classList.add("touch");
      this.el.joystick?.classList.remove("hud-hidden");
    }
  }

  showLoading(show) { this.el.loading.classList.toggle("hud-hidden", !show); }
  setLoadProgress(p) { this.el.loadFill.style.width = `${Math.round(p * 100)}%`; }

  /* ------------------------------------------------------------ room */

  setRoom(room, idx, total) {
    this._room = room; this._idx = idx; this._total = total;
    const t = i18n.t, L = i18n.lang;
    const name = room.name[L] || room.name.en;
    this.el.roomTitle.textContent = name;
    this.el.roomTitle.title = name;
    // badge (owner law 3): 🧊 true-3D rooms vs 🌐 zero-warp 4K panorama rooms
    const badge = (room.badge && (room.badge[L] || room.badge.en)) || "";
    this.el.roomBadge.textContent = badge;
    this.el.roomBadge.title = badge;
    this.el.roomBadge.style.display = badge ? "" : "none";
    this.el.roomDesigner.textContent = room.attribution.creator;
    this.el.roomSource.textContent = `${room.attribution.source} · ${room.attribution.license}`;
    this.el.roomSource.href = room.attribution.url;
    this.el.navName.textContent = name;
    this.el.navName.title = name;
    this.el.navCount.textContent = t.counter(idx + 1, total);
    if (this.el.radarLabel) this.el.radarLabel.textContent = t.radar_btn.split("(")[0].trim();
  }

  /* ------------------------------------------------------------ view button */

  _setViewTitles() {
    const moved = this._moved;
    this.el.btnView.setAttribute("title", moved ? i18n.t.reset_view : i18n.t.fullscreen);
    this.el.btnView.setAttribute("aria-label", moved ? i18n.t.reset_view : i18n.t.fullscreen);
    this.el.btnViewReset.style.display = moved ? "" : "none";
    this.el.btnViewFull.style.display = moved ? "none" : "";
  }

  setMoved(moved) {
    if (moved === this._moved) return;
    this._moved = moved;
    this._setViewTitles();
  }

  /* ------------------------------------------------------------ sound */

  onSoundToggle(fn) { this._onSound = fn; }
  onRadarToggle(fn) { this._onRadar = fn; }

  setMuted(muted) {
    this._muted = !!muted;
    this._setSoundTitles();
  }

  /* ------------------------------------------------------------ routing modes */

  onModeChange(fn) { this._onMode = fn; }

  setMode(mode) {
    this._mode = mode;
    this._setModeLabels();
    // transient full-name toast so the choice is explicit, then it vanishes
    const t = i18n.t;
    const fulls = {
      architect: t.mode_architect_full,
      style: t.mode_style_full,
      room_type: t.mode_room_type_full,
      random: t.mode_random_full,
    };
    this.showBump(fulls[mode], 1800);
  }

  get mode() { return this._mode; }

  /* ------------------------------------------------------------ bindings */

  onLangToggle(fn) { this.el.btnLang.addEventListener("click", fn); }
  onViewButton(fn) { this.el.btnView.addEventListener("click", fn); }
  onNavigate(fn) {
    this.el.navPrev.addEventListener("click", () => fn(-1));
    this.el.navNext.addEventListener("click", () => fn(1));
  }

  /* ------------------------------------------------------------ joystick */

  /** Bind the analog walk joystick. cb({x, y}) with -1..1, up = forward. */
  bindJoystick(cb) {
    const base = this.el.joyBase, knob = this.el.joyKnob, host = this.el.joystick;
    if (!base) return;
    let active = null;

    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(${dx * 26}px, ${dy * 26}px)`;
    };

    base.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      active = e.pointerId;
      host.classList.add("live");
      try { base.setPointerCapture(e.pointerId); } catch (err) {}
      handle(e);
    });
    const handle = (e) => {
      if (active === null) return;
      const r = base.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2);
      let dy = (e.clientY - cy) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      if (len < 0.14) { dx = 0; dy = 0; }         // dead zone
      setKnob(dx, dy);
      cb({ x: dx, y: -dy });                      // up on the stick = forward
    };
    base.addEventListener("pointermove", (e) => {
      if (e.pointerId === active) handle(e);
    });
    const release = (e) => {
      if (e.pointerId !== active) return;
      active = null;
      host.classList.remove("live");
      setKnob(0, 0);
      cb({ x: 0, y: 0 });
    };
    base.addEventListener("pointerup", release);
    base.addEventListener("pointercancel", release);
  }

  /* ------------------------------------------------------------ collision feedback */

  /** Transient obstacle toast: "برخورد با مانع: پیانو گرند". */
  showBump(text, ms = 1500) {
    const el = this.el.bumpToast;
    this.el.bumpLabel.textContent = text;
    el.classList.remove("hud-hidden");
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(this._bumpTimer);
    this._bumpTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.classList.add("hud-hidden"), 240);
    }, ms);
  }

  /** Radial glass ripple at a screen position (obstacle bump point). */
  ripple(x, y) {
    const host = this.el.rippleHost;
    if (!host) return;
    const r = document.createElement("div");
    r.className = "bump-ripple";
    r.style.left = `${Math.min(Math.max(x, 16), innerWidth - 16)}px`;
    r.style.top = `${Math.min(Math.max(y, 16), innerHeight - 16)}px`;
    host.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  /* ------------------------------------------------------------ waypoint chip */

  onWaypointChip(fn) { this._onChip = fn; }

  showWaypointChip(room, x, y) {
    this._chipRoom = room;
    const L = i18n.lang;
    this.el.wpChipLabel.textContent = `${i18n.t.enter_room} ${room.name[L] || room.name.en}`;
    this.el.wpChip.classList.remove("hud-hidden");
    this.placeWaypointChip(x, y);
  }

  placeWaypointChip(x, y) {
    const r = this.el.wpChip.getBoundingClientRect();
    const PAD = 10;
    const cx = Math.min(Math.max(x, PAD + r.width / 2), innerWidth - PAD - r.width / 2);
    const cy = Math.min(Math.max(y - r.height - 18, PAD + r.height / 2), innerHeight - PAD - r.height / 2);
    this.el.wpChip.style.left = `${Math.round(cx)}px`;
    this.el.wpChip.style.top = `${Math.round(cy)}px`;
  }

  hideWaypointChip() {
    this._chipRoom = null;
    this.el.wpChip.classList.add("hud-hidden");
  }

  get chipOpen() { return !!this._chipRoom; }
}
