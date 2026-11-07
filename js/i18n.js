/**
 * PANODROME — Stage 1.5 · i18n (EN / FA-RTL)
 * Authentic Persian architectural tone · Vazirmatn typography.
 */

const STRINGS = {
  en: {
    tagline: "The spatial & living architecture collection — walk through real spaces, zero-warp.",
    intro_sub: "One true-3D villa + ten 4K panoramas · zero-warp walking · furniture collision",
    intro_hint: "Drag to look · Scroll or W A S D to step-glide · Double-tap the floor or a glass furniture marker",
    enter: "Enter Panodrome",
    credit: "🧊 true-3D villa (built-in) · 🌐 360° panoramas · PolyHaven CC0 + Wikimedia Commons",
    nav_prev: "Previous space",
    nav_next: "Next space",
    hint: "Scroll or W A S D to step-glide · walk into the door ring to travel",
    hint_touch: "Scroll, pull the joystick or double-tap the floor to step-glide",
    reset_view: "Step back to centre",
    fullscreen: "Fullscreen",
    walk_f: "Move forward",
    walk_b: "Step back",
    enter_room: "Enter",
    loading: "Preparing the space…",
    lang_btn: "فا",
    counter: (i, n) => `(${i} of ${n})`,
    /* Stage 1.5 */
    mode_architect: "Architect",
    mode_style: "Style",
    mode_room_type: "Room Type",
    mode_random: "Random",
    mode_bar_label: "Routing",
    mode_architect_full: "Architect route — next space by the same creator",
    mode_style_full: "Style filter — next space in the same style family",
    mode_room_type_full: "Room type — next space of the same kind",
    mode_random_full: "Random discovery — a serendipitous next space",
    sound_on: "Sound on",
    sound_off: "Sound off",
    bump_prefix: "Obstacle:",
    wall_label: "Wall",
    joystick: "Walk joystick",
    walked: (m) => `${m.toFixed(1)} m walked`,
    /* live floorplan radar (stage 2.1 port, 2026-11-04 purge keeps it) */
    radar_btn: "Live floorplan radar",
    doorway: "Doorway",
  },
  fa: {
    tagline: "مجموعه‌ معماریِ فضایی و زیست‌پذیر — در فضاهای واقعی قدم بزنید، بدون هیچ اعوجاجی.",
    intro_sub: "یک ویلای سه‌بعدی واقعی + ده پانورامای 4K · قدم‌زدن بدون اعوجاج · برخورد با مبلمان",
    intro_hint: "برای گردش بکشید · برای گام‌زدن اسکرول یا W A S D · روی کف یا نشانگر شیشه‌ای مبلمان دو بار ضربه بزنید",
    enter: "ورود به پانودروم",
    credit: "🧊 ویلای سه‌بعدی واقعی (ساخت داخل) · 🌐 پانورامای ۳۶۰ درجه · پلی‌هیون CC0 + ویکی‌مدیا کامانز",
    nav_prev: "فضای قبلی",
    nav_next: "فضای بعدی",
    hint: "برای گام‌زدن اسکرول یا W A S D · برای سفر، وارد حلقهٔ در شوید",
    hint_touch: "اسکرول کنید، اهرم را بکشید یا روی کف دو بار ضربه بزنید",
    reset_view: "بازگشت به مرکز فضا",
    fullscreen: "نمایش تمام‌صفحه",
    walk_f: "حرکت به جلو",
    walk_b: "حرکت به عقب",
    enter_room: "ورود",
    loading: "در حال آماده‌سازی فضا…",
    lang_btn: "EN",
    counter: (i, n) => `(${faDigits(i)} از ${faDigits(n)})`,
    /* Stage 1.5 */
    mode_architect: "معمار",
    mode_style: "سبک",
    mode_room_type: "نوع فضا",
    mode_random: "تصادفی",
    mode_bar_label: "مسیر",
    mode_architect_full: "مسیر معمار — فضای بعدی از همان سازنده",
    mode_style_full: "فیلتر سبک — فضای بعدی در همان خانوادهٔ سبکی",
    mode_room_type_full: "نوع فضا — فضای بعدی از همان دسته",
    mode_random_full: "کشف تصادفی — فضای بعدی، غافلگیرکننده",
    sound_on: "صدا روشن",
    sound_off: "صدا خاموش",
    bump_prefix: "برخورد با مانع:",
    wall_label: "دیوار",
    joystick: "اهرم راه رفتن",
    walked: (m) => `${faDigits(m.toFixed(1))} متر راه رفتید`,
    radar_btn: "📐 پلان زنده گوشه تصویر",
    doorway: "دروازه",
  },
};

function faDigits(s) {
  const map = { "0": "۰", "1": "۱", "2": "۲", "3": "۳", "4": "۴", "5": "۵", "6": "۶", "7": "۷", "8": "۸", "9": "۹", ".": "٫" };
  return String(s).replace(/[0-9.]/g, (d) => map[d]);
}

class I18n {
  constructor() {
    this.lang = "en";
    this._listeners = new Set();
  }
  get t() { return STRINGS[this.lang]; }
  setLang(lang) {
    if (!STRINGS[lang] || lang === this.lang) return;
    this.lang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
    document.body.classList.toggle("fa", lang === "fa");
    this._listeners.forEach((fn) => fn());
  }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
}

export const i18n = new I18n();
export { faDigits };
