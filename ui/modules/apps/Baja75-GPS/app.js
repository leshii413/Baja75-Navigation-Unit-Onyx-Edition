/* Tread XL - Baja Chase Edition GPS (Baja75) - BeamNG.drive HUD app (legacy Angular directive, runs in CEF).
 *
 * Layout mimics the 10" Tread XL Baja navigator: rugged bezel, status bar, rolling waypoint deck on the left,
 * tappable data fields, speed bubble with speed-limit sign and scale bar, map buttons, REC / MARK / CHASE / MENU.
 *
 * All logic lives in lua/ge/extensions/TreadXLGPS.lua; this file only draws and forwards clicks.
 * The renderer (TreadXLApp) is framework-free so it can be previewed in a normal browser (dev/preview).
 *
 * Map: we draw it ourselves (WorldView). Our Lua sends the level's road network (the AI road graph BeamNG's
 * own map is built from) and terrain image tiles. Everything lives in one SVG in world coordinates, moved
 * under the vehicle with a single CSS transform per frame, so the course line, waypoints and roads line up.
 * Nearby vehicles (other BeamMP players, AI) are drawn on top from the Lua HUD feed.
 */
(function () {
  'use strict';

  var APP_DIR = '/ui/modules/apps/Baja75-GPS/';
  var ICON_DIR = APP_DIR + 'Baja75-GPSicons/';
  var EV = 'TreadXLGPS.';
  var VERSION = '3.4';
  // which build this is: 'full' (all four modes), 'chase', 'rally', 'track' (single-mode editions), 'common' or 'free'; dev/package.py sets it
  var EDITION = 'onyx';
  var EDITION_NAME = { full: '', chase: 'Chase Edition', rally: 'Rally Edition', track: 'Track Edition', common: 'Common Edition', free: 'Free Edition', onyx: 'Onyx Edition' }[EDITION] || '';
  // the package letter by the version on the case: C Chase, R Rally, T Track, P Public (Common); the full unit shows the version only
  var EDITION_TAG = { chase: 'C', rally: 'R', track: 'T', common: 'P', free: 'F', onyx: 'O' }[EDITION] || '';
  // v3.1.9: themes (case, colours, home screen). Each zip has its own: dev/package.py rewrites THEMES_ON
  // (Track: JDM, Drift; Rally: Rally; Chase: Desert Racing, Rock Crawling; Adventure: Overland; the full unit: all; Anime: every edition but Onyx)
  var THEMES_ON = [];
  var THEMES = [
    { id: 'baja75', name: 'Baja75' },
    { id: 'desert', name: 'Desert Racing', accent: '#ff6a13' },
    { id: 'rock', name: 'Rock Crawling', accent: '#f5c400', logo: 1 },
    { id: 'rally', name: 'Rally', accent: '#e3262b', logo: 1 },
    { id: 'jdm', name: 'JDM', accent: '#e3262b', logo: 1 },
    { id: 'drift', name: 'Drift', accent: '#ff2fa8', logo: 1 },
    { id: 'overland', name: 'Overland', accent: '#c9a25a', logo: 1 },
    { id: 'anime', name: 'Anime', accent: '#c89cf0', logo: 1 }
  ].filter(function (t) { return t.id === 'baja75' || THEMES_ON.indexOf(t.id) >= 0; });
  function themeOf(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }
  // the Onyx Edition: road and overland exploration in a metallic black unit; no races, Chase Map or unlocking
  var ONYX = EDITION === 'onyx';
  var ONYX_KINDS = { hazard: 1, danger: 1, medic: 1, note: 1, turn: 1 }; // what it marks (no race symbols)
  var ONYX_OFF = { passReq: 1, passOk: 1, passDismiss: 1, raceGo: 1, raceRoute: 1, chase: 1, autoPn: 1, clearAutoPn: 1, serverPack: 1, vidPaste: 1, vidBrowser: 1, vidGo: 1, vidRecent: 1, siteCheck: 1, videoUnblock: 1, keyOpen: 1, unlockGo: 1 };
  // the free Common Edition: all four modes with the map, music, course import, Times, racing and 2 courses of your own;
  // no video, marking, waypoint / pacenote writing, Chase Map or sharing out (the game script refuses those too)
  var COMMON = EDITION === 'common' || EDITION === 'free'; // the free editions: no password (keys only), Adventure first
  var FREE = EDITION === 'free';
  // on a Baja75 server every edition has every feature (v3.1.1): FULL comes from the game script's hello
  var FULL = false;
  function ED() { return FULL ? 'full' : EDITION; }   // the edition in effect
  function isCommon() { var e = ED(); return e === 'common' || e === 'free'; } // the Common Edition's limits (the Free Edition has them too)
  function PLUS() { return !isCommon(); } // v3.4: the map / music / gallery extras: every edition but Free and Common (off the servers)
  function isFree() { return ED() === 'free'; } // the Free Edition off the servers: Adventure only, no REC, video or waypoint list, settings view-only
  var FREE_OFF = { recToggle: 1, recStart: 1, undoMark: 1, vidFull: 1, vidPlay: 1, vidPaste: 1, vidBrowser: 1, vidGo: 1, resetTrip: 1, siteCheck: 1, videoUnblock: 1, reloadMap: 1, mediaSplit: 1 };
  var COMMON_OFF = { mark: 1, chase: 1, autoPn: 1, clearAutoPn: 1, editNotes: 1, exportGpx: 1, serverPack: 1 }; // (video: yes, from v3.1.2)
  // the Chase Edition's only symbols: pits, start / finish, VCPs, speed zone start / end
  var CHASE_KINDS = { pit: 1, start: 1, vcp: 1, zone: 1, zoneEnd: 1 };
  function shownKind(k) { return ED() !== 'chase' || !!CHASE_KINDS[k]; }
  function cleanDriver(v, n) { return String(v == null ? '' : v).replace(/[|\r\n\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+/, '').slice(0, n); }
  var NS = 'http://www.w3.org/2000/svg';
  var M_PER_MI = 1609.344, M_PER_FT = 0.3048, MPS_TO_MPH = 2.2369362920544, MPS_TO_KMH = 3.6;

  // symbol catalogue (used when Lua hasn't sent the icon list yet, and for names/order)
  var ICONS = [
    { file: 'Tread_XL_icon_checkpoint.svg', name: 'VCP', kind: 'vcp' },
    { file: 'Tread_XL_icon_speedzone.svg', name: 'Speed Zone', kind: 'zone' },
    { file: 'Tread_XL_icon_speedzone_end.svg', name: 'End Zone', kind: 'zoneEnd' },
    { file: 'Tread_XL_icon_warning.svg', name: 'Hazard', kind: 'hazard' },
    { file: 'Tread_XL_icon_death.svg', name: 'Danger', kind: 'danger' },
    { file: 'Tread_XL_icon_rock.svg', name: 'Rock', kind: 'hazard' },
    { file: 'Tread_XL_icon_tree.svg', name: 'Tree', kind: 'hazard' },
    { file: 'Tread_XL_icon_repair.svg', name: 'Pit', kind: 'pit' },
    { file: 'Tread_XL_icon_stop.svg', name: 'Stop', kind: 'stop' },
    { file: 'Tread_XL_icon_health.svg', name: 'Medic', kind: 'medic' },
    { file: 'Tread_XL_icon_start_finish.svg', name: 'Start/Finish', kind: 'start' },
    { file: 'Tread_XL_icon_turn_left.svg', name: 'Turn Left', kind: 'turn' },
    { file: 'Tread_XL_icon_turn_right.svg', name: 'Turn Right', kind: 'turn' },
    { file: 'Tread_XL_icon_exit.svg', name: 'Exit', kind: 'note' },
    { file: 'Tread_XL_icon_mystery.svg', name: 'Note', kind: 'note' }
  ];
  var ICON_BY_FILE = {};
  ICONS.forEach(function (i) { ICON_BY_FILE[i.file] = i; });
  function shownIcon(f) { var i = ICON_BY_FILE[f]; if (ONYX) return !!(i && ONYX_KINDS[i.kind]); return i ? shownKind(i.kind) : ED() !== 'chase'; }

  var COURSE_COLORS = ['#e8178a', '#ff6a13', '#1d8cff', '#7a2cff', '#00b86b', '#111111'];
  var CHASE_INTERVALS = [[0, 'LIVE'], [30, '30 S'], [60, '1 MIN'], [120, '2 MIN'], [240, '4 MIN']];
  var SOURCE_LABEL = { mine: 'My courses', rally: 'Rally Courses', server: 'Server courses', legacy: 'Older saves (v1 / v2.0)' };
  // courses that can't be changed here: a server's, and the Rally Courses made from the map's own missions
  function readOnlySrc(src) { return src === 'server' || src === 'rally'; }

  var DEFAULTS = {
    units: 'imperial', northUp: false, bezel: true, deck: true, fields: ['raceMile', 'toNext', 'toFinish'],
    freeFields: ['heading', 'elevation', 'trip'],
    courseColor: '#e8178a', sharpTurns: true, autoZoom: true, zoom: 0.8, showOthers: true, othersNames: true,
    chaseInterval: 0, markIcon: 'Tread_XL_icon_checkpoint.svg', markLabel: '', markLimit: 35, mapOpacity: 1,
    clockSource: 'pc', darkMode: ONYX ? 'on' : 'off', chipVcp: true, chipPit: true, sound: true, chimeVol: 0.6, // (the Onyx Edition starts on the night map)
    alertsOnGps: true, alertsMode: 'faults', alertsFlash: true, passBtn: true, // passBtn: v3.3
    mbarPos: 'bottom', cleanMap: false, mapBtns: true, actBtns: true, showFields: true, showSpeed: true, showScale: true, // v3.4
    markMode: 'symbols', pnDraft: { d: 1, c: 'three', len: '', sh: '', ca: 0, m: [] }, pnBar: true,
    pnCalls: 'on', pnLead: 'normal', pnVoice: '', pnNative: true, offCourseM: 15, damageLog: true, snapStyle: 'map',
    mode: COMMON ? 'adventure' : 'chase', commonPreset: 0, modeFields: {}, split: false, display: 'gps', lastMedia: 'music', videoScreen: true, musicScreen: true, vidPip: 'br', musStyle: 'split', musPip: 'br',
    mediaVol: 0.7, mediaMuted: false, recentLinks: [], musicShuffle: false, musicRepeat: 'all',
    gaugesScreen: true, musicBar: true, musicWithCalls: false, pnPop: 'called', videoWeb: true, videoPage: '', videoBlocked: {}, driverName: '', raceNumber: '',
    theme: 'baja75', themeNext: '', // v3.1.9
    dash: false // v3.2: on the vehicle's own navigation screen (this HUD app then pops up to edit): the theme in use, and one chosen in Display (applied by the power button)
  };
  var PN_ICON = 'Tread_XL_icon_pacenote.svg';
  // course names that get "Race This Route"
  function isRaceName(n) { return /race|rally|challenge/i.test(String(n || '')); }
  var ZOOM_MIN = 0.03, ZOOM_MAX = 6;
  var RESULT_SECONDS = 90; // the finish card stays this long (or until closed)
  // power-on screen after joining a map: BOOT_LOAD ms of loading (the start-up chime plays at the end of it), then
  // BOOT_READ ms more so the screen can be read; never longer than BOOT_MAX ms if the map takes long
  var BOOT_LOAD = 15000, BOOT_READ = 5000, BOOT_MAX = 45000;
  var BOOT_RESTART_LOAD = 4000, BOOT_RESTART_READ = 2500, RESTART_DARK = 900; // the power button (Restart System)

  // ---------------------------------------------------------------- small helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Lua string literal: safe for any text (quotes, backslashes, newlines, control chars)
  function luaStr(s) {
    s = String(s == null ? '' : s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), code = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '"') out += '\\"';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (code < 32 || code === 127) out += '\\' + ('00' + code).slice(-3);
      else out += ch;
    }
    return out + '"';
  }
  // Lua's JSON encoder sends an empty table as {} - treat anything that isn't an array as empty
  function arr(x) { return Array.isArray(x) ? x : []; }
  function dispName(n) { return String(n == null ? '' : n).replace(/_/g, ' '); }
  function luaNum(n) { n = Number(n); return isFinite(n) ? String(n) : 'nil'; }
  function svgEl(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function setHref(el, url) {
    el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
    el.setAttribute('href', url);
  }
  function loadSettings() {
    var s = {};
    for (var k in DEFAULTS) s[k] = Array.isArray(DEFAULTS[k]) ? DEFAULTS[k].slice() : DEFAULTS[k];
    try {
      var raw = JSON.parse(window.localStorage.getItem('txlSettings') || '{}');
      for (var k2 in raw) if (k2 in DEFAULTS && typeof raw[k2] === typeof DEFAULTS[k2]) s[k2] = raw[k2];
      // v2.4/2.5 kept the off-course warning in feet (50 / 100 / 200)
      if (raw.offCourseM == null && typeof raw.offCourseFt === 'number') s.offCourseM = raw.offCourseFt >= 200 ? 60 : raw.offCourseFt >= 100 ? 30 : 15;
    } catch (_) { /* storage unavailable: defaults */ }
    s.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(s.zoom) || DEFAULTS.zoom));
    // v3: the Common Edition comes set to Adventure Mode (once; the player can switch modes after)
    if (COMMON && s.commonPreset !== 1) { s.mode = 'adventure'; s.commonPreset = 1; }
    return s;
  }
  function saveSettings(s) { try { window.localStorage.setItem('txlSettings', JSON.stringify(s)); } catch (_) { } }
  function courseKey(name, source) { return (source || 'mine') + '|' + name; }

  // ---------------------------------------------------------------- formatting
  function fmtDist(m, units) {
    if (typeof m !== 'number' || !isFinite(m)) return { v: '--', u: '' };
    var neg = m < 0; m = Math.abs(m);
    var r;
    if (units === 'metric') {
      if (m < 997.5) r = { v: String(Math.round(m / 5) * 5), u: 'm' };
      else { var km = m / 1000; r = { v: km.toFixed(km < 10 ? 2 : km < 100 ? 1 : 0), u: 'km' }; }
    } else {
      if (m < 0.1 * M_PER_MI) r = { v: String(Math.round(m / M_PER_FT / 10) * 10), u: 'ft' };
      else { var mi = m / M_PER_MI; r = { v: mi.toFixed(mi < 10 ? 2 : mi < 100 ? 1 : 0), u: 'mi' }; }
    }
    if (neg) r.v = '\u2212' + r.v;
    return r;
  }
  function fmtRM(m, units) {
    if (typeof m !== 'number' || !isFinite(m)) return '--';
    return (m / (units === 'metric' ? 1000 : M_PER_MI)).toFixed(1);
  }
  function fmtSpeed(mps, units) {
    if (typeof mps !== 'number' || !isFinite(mps)) return { v: '--', u: units === 'metric' ? 'km/h' : 'mph' };
    return units === 'metric' ? { v: String(Math.round(mps * MPS_TO_KMH)), u: 'km/h' } : { v: String(Math.round(mps * MPS_TO_MPH)), u: 'mph' };
  }
  function mphTo(mph, units) { return units === 'metric' ? Math.round(mph * 1.609344) : Math.round(mph); }
  function compass(deg) {
    var d = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return d[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }
  function clockText(tod) {
    var h, m;
    if (typeof tod === 'number' && isFinite(tod)) { h = Math.floor(tod / 3600) % 24; m = Math.floor(tod / 60) % 60; }
    else { var d = new Date(); h = d.getHours(); m = d.getMinutes(); }
    return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  // race time: 1:23.4 or 1:02:03.4
  function fmtRace(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '--';
    var neg = sec < 0; sec = Math.abs(sec);
    var t = Math.floor(sec * 10 + 1e-6), d = t % 10, ss = Math.floor(t / 10) % 60, mm = Math.floor(t / 600) % 60, hh = Math.floor(t / 36000);
    return (neg ? '-' : '') + (hh ? hh + ':' + ('0' + mm).slice(-2) : mm) + ':' + ('0' + ss).slice(-2) + '.' + d;
  }
  function ageText(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  // map scale bar: a round distance that is 40-110 px long at this zoom
  var SCALE_STEPS = {
    imperial: [[25, 'ft', M_PER_FT], [50, 'ft', M_PER_FT], [100, 'ft', M_PER_FT], [200, 'ft', M_PER_FT], [500, 'ft', M_PER_FT],
      [1000, 'ft', M_PER_FT], [0.25, 'mi', M_PER_MI], [0.5, 'mi', M_PER_MI], [1, 'mi', M_PER_MI], [2, 'mi', M_PER_MI],
      [5, 'mi', M_PER_MI], [10, 'mi', M_PER_MI], [20, 'mi', M_PER_MI], [50, 'mi', M_PER_MI]],
    metric: [[10, 'm', 1], [20, 'm', 1], [50, 'm', 1], [100, 'm', 1], [200, 'm', 1], [500, 'm', 1], [1, 'km', 1000],
      [2, 'km', 1000], [5, 'km', 1000], [10, 'km', 1000], [20, 'km', 1000], [50, 'km', 1000]]
  };
  function scaleBar(zoom, units) {
    var steps = SCALE_STEPS[units === 'metric' ? 'metric' : 'imperial'], best = steps[0];
    for (var i = 0; i < steps.length; i++) { if (steps[i][0] * steps[i][2] * zoom <= 110) best = steps[i]; }
    return { px: best[0] * best[2] * zoom, label: best[0] + ' ' + best[1] };
  }

  // ---------------------------------------------------------------- inline glyphs
  var G = {
    gps: '<svg viewBox="0 0 20 14"><rect x="0" y="10" width="3.2" height="4" rx=".6" fill="#fff"/><rect x="5" y="7" width="3.2" height="7" rx=".6" fill="#fff"/><rect x="10" y="3.5" width="3.2" height="10.5" rx=".6" fill="#fff"/><rect x="15" y="0" width="3.2" height="14" rx=".6" fill="#fff"/></svg>',
    power: '<svg viewBox="0 0 12 18"><path d="M7 0 0 10h4.5L3.5 18 12 7H7.2z" fill="#ffc21a"/></svg>',
    sat: '<svg viewBox="0 0 18 18"><g fill="none" stroke="#fff" stroke-width="1.6"><rect x="6" y="6" width="6" height="6" rx="1" transform="rotate(45 9 9)"/><path d="M3.5 3.5 6 6M12 12l2.5 2.5"/><path d="M1 7.5 4.5 4l3.5 3.5M10 14l3.5-3.5L17 14" stroke-linejoin="round"/></g></svg>',
    expand: '<svg viewBox="0 0 18 18"><path d="M2 7V2h5M11 2h5v5M16 11v5h-5M7 16H2v-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    shrink: '<svg viewBox="0 0 18 18"><path d="M7 2v5H2M16 7h-5V2M11 16v-5h5M2 11h5v5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pwr: '<svg viewBox="0 0 18 18"><path d="M5.2 4.6a6.2 6.2 0 1 0 7.6 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M9 1.6v7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    house: '<svg class="hw-ico" viewBox="0 0 24 24"><path d="M3 11.2 12 3.5l9 7.7V21h-6.2v-6.2H9.2V21H3z" fill="currentColor"/></svg>',
    hMusic: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.6" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="17.5" cy="16" r="2.6" fill="none" stroke="#fff" stroke-width="1.6"/></svg>',
    hVideo: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="3.5" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M10 9.2v5.6l4.8-2.8z" fill="#fff"/></svg>',
    hMaps: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M15.5 8.5 13.2 13.2 8.5 15.5 10.8 10.8z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    hSettings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    hGallery: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="8.5" cy="9.5" r="1.7" fill="#fff"/><path d="M3.5 17l5-5 4 4 3-3 5 5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3 3 13" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    menu: '<svg viewBox="0 0 18 18"><path d="M2 4h14M2 9h14M2 14h14" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    undo: '<svg viewBox="0 0 18 18"><path d="M4.2 6.2H11a4.4 4.4 0 0 1 0 8.8H6.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M7 2.8 3.6 6.2 7 9.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mark: '<svg viewBox="0 0 18 18"><path d="M9 1.5c-3.2 0-5.5 2.3-5.5 5.4C3.5 11 9 16.5 9 16.5s5.5-5.5 5.5-9.6C14.5 3.8 12.2 1.5 9 1.5z" fill="#111"/><circle cx="9" cy="6.9" r="2.1" fill="#ff6a13"/></svg>',
    chase: '<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="9" cy="9" r="2.6" fill="#fff"/><path d="M9 0v3.2M9 14.8V18M0 9h3.2M14.8 9H18" stroke="#fff" stroke-width="1.8"/></svg>',
    rec: '<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.2" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="9" cy="9" r="4.2" fill="#ff3b30"/></svg>',
    stop: '<svg viewBox="0 0 18 18"><rect x="3.5" y="3.5" width="11" height="11" rx="2" fill="#fff"/></svg>',
    pass: '<svg viewBox="0 0 18 18"><path d="M3 4.5 7.5 9 3 13.5M9 4.5 13.5 9 9 13.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lock: '<svg viewBox="0 0 24 28"><path d="M6.5 12V8a5.5 5.5 0 0 1 11 0v4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><rect x="2" y="12" width="20" height="15" rx="3" fill="#ff6a13"/><circle cx="12" cy="18.6" r="2.1" fill="#111"/><path d="M12 19.5v3.6" stroke="#111" stroke-width="2" stroke-linecap="round"/></svg>',
    center: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" fill="none" stroke="#fff" stroke-width="2"/><circle cx="10" cy="10" r="2.2" fill="#fff"/><path d="M10 0v4M10 16v4M0 10h4M16 10h4" stroke="#fff" stroke-width="2"/></svg>',
    needle: '<svg viewBox="0 0 26 26"><path d="M13 2 17.5 13h-9z" fill="#ff3b30"/><path d="M13 24 8.5 13h9z" fill="#e8e8e8"/><circle cx="13" cy="13" r="1.6" fill="#111"/></svg>',
    arrow: '<svg viewBox="0 0 26 26"><path d="M13 2 22 23l-9-5-9 5z" fill="#ff6a13" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 18 18"><path d="M3 5h12M7 5V3h4v2M5 5l.8 10h6.4L13 5" fill="none" stroke="#ff8a80" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    race: '<svg viewBox="0 0 18 18"><path d="M3.5 1.5v15" stroke="#111" stroke-width="1.8" stroke-linecap="round"/><path d="M4.5 2.5h11v7.5h-11z" fill="#fff" stroke="#111" stroke-width="1"/><path d="M4.5 2.5h2.75v2.5H4.5zm5.5 0h2.75v2.5H10zM7.25 5h2.75v2.5H7.25zm5.5 0h2.75v2.5h-2.75zM4.5 7.5h2.75V10H4.5zm5.5 0h2.75V10H10z" fill="#111"/></svg>',
    pit: '<svg viewBox="0 0 18 18"><rect x="1" y="1" width="16" height="16" rx="3" fill="#1d5fd6"/><path d="M11.8 3.6a3 3 0 0 0-3.4 3.9L4 11.9a1.3 1.3 0 0 0 1.9 1.9l4.4-4.4a3 3 0 0 0 3.9-3.4l-1.7 1.7-1.6-.4-.4-1.6z" fill="#fff"/></svg>',
    speaker: '<svg viewBox="0 0 18 18"><path d="M2 6.5h3.2L9.5 3v12L5.2 11.5H2z" fill="#fff"/><path d="M12 6.2a4 4 0 0 1 0 5.6M14.2 4a7 7 0 0 1 0 10" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    kbd: '<svg viewBox="0 0 20 14"><rect x="1" y="1" width="18" height="12" rx="2" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M4.5 4.6h1.3M7.8 4.6h1.3M11 4.6h1.3M14.2 4.6h1.3M4.5 7.4h1.3M7.8 7.4h1.3M11 7.4h1.3M14.2 7.4h1.3M6.5 10.2h7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M9 17.5V5.2l11-2.2v12.3" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.9" fill="#fff"/><circle cx="17.4" cy="15.4" r="2.9" fill="#fff"/></svg>',
    folder: '<svg viewBox="0 0 18 18"><path d="M1.5 4.5a1 1 0 0 1 1-1h4l1.6 1.8h7.4a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 2 23 21H1z" fill="#111"/><path d="M12 9v5" stroke="#ffc21a" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.4" fill="#ffc21a"/></svg>',
    wrong: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#111"/><path d="M12 6v9M8 11l4 4 4-4" stroke="#ffc21a" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 12 12)"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M5 2v20" stroke="#fff" stroke-width="2"/><path d="M6 3h14v10H6z" fill="#fff"/><path d="M6 3h3.5v2.5H6zm7 0h3.5v2.5H13zM9.5 5.5H13V8H9.5zm7 0H20V8h-3.5zM6 8h3.5v2.5H6zm7 0h3.5v2.5H13zM9.5 10.5H13V13H9.5zm7 0H20V13h-3.5z" fill="#111"/></svg>'
  };

  // >>> shared pacenote tiles: dev/sync_pn_tiles.py copies this block into the Tread XL Pacenotes app (uses esc, arr)
  // ---------------------------------------------------------------- rally pacenote tiles
  // Tiles follow BeamNG's own visual pacenotes: the tile list (icon id, 1-6 / HP / SQ / FL, colours, into, distance,
  // shape and cut badges) comes from the game's rally style through our Lua. The game's icon font can't be addressed
  // from a mod, so the icon ids are drawn with these small vector glyphs.
  var BNG_VARS = {
    '--bng-off-black': '#1b1d21', '--bng-off-white': '#f2f2f2', '--bng-orange': '#ff6600', '--bng-orange-500': '#d95700',
    '--bng-add-red-550': '#e5382b', '--bng-add-red-650': '#b8281e', '--bng-add-red-750': '#8f1d15',
    '--bng-ter-yellow-400': '#ffcf33', '--bng-ter-yellow-500': '#f2b705', '--bng-ter-peach-300': '#ffb59a', '--bng-ter-peach-400': '#ff9a73',
    '--bng-add-blue-500': '#3d8bff', '--bng-add-blue-600': '#2a6fd6', '--bng-add-indigoblue-650': '#4b45c9', '--bng-add-indigoblue-750': '#36319a',
    '--bng-add-green-500': '#29b864', '--bng-add-green-600': '#1f9150'
  };
  function bngColor(c, fallback) {
    if (c == null || c === '') return fallback || '';
    return String(c).replace(/var\((--[\w-]+)\)/g, function (_, v) { return 'var(' + v + ', ' + (BNG_VARS[v] || '#777') + ')'; });
  }
  var PN_GLYPH = (function () {
    var f = function (n) { return n.toFixed(2); };
    var S = '<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">';
    function head(x, y, a) { // arrowhead at (x, y) pointing along compass angle a (radians, 0 = up, clockwise)
      var dx = Math.sin(a), dy = -Math.cos(a), px = -dy, py = dx;
      return '<path d="M' + f(x + dx * 2.2) + ' ' + f(y + dy * 2.2) + 'L' + f(x - dx * 4 + px * 3.6) + ' ' + f(y - dy * 4 + py * 3.6) + 'L' + f(x - dx * 4 - px * 3.6) + ' ' + f(y - dy * 4 - py * 3.6) + 'Z" fill="currentColor" stroke="none"/>';
    }
    function turn(A, R, exit) { // a right turn: straight up, then A degrees of arc with radius R (drawn mirrored for left)
      var a = A * Math.PI / 180, w = R * (1 - Math.cos(a)), top = A >= 90 ? R : R * Math.sin(a);
      var x0 = 12 - w / 2 - (A > 120 ? 1 : 1.5), y0 = Math.max(6, 4 + top + (A >= 90 ? 0 : 2.5)), d = 'M' + f(x0) + ' 21V' + f(y0);
      var x = x0, y = y0;
      for (var i = 1; i <= 12; i++) { var t = a * i / 12; x = x0 + R - R * Math.cos(t); y = y0 - R * Math.sin(t); d += 'L' + f(x) + ' ' + f(y); }
      if (exit) { x += Math.sin(a) * exit; y += -Math.cos(a) * exit; d += 'L' + f(x) + ' ' + f(y); }
      return S + '<path d="' + d + '"/></g>' + head(x, y, a);
    }
    return {
      turn1: turn(160, 4.2, 4.5), turn2: turn(125, 5.2, 2.5), turn3: turn(92, 6.5), turn4: turn(68, 8.5), turn5: turn(46, 12), turn6: turn(26, 18),
      turnHp: turn(180, 3.8, 6), turnSq: S + '<path d="M8 21V9H15"/></g>' + head(15.5, 9, Math.PI / 2),
      caution: S + '<path d="M12 3 22 20H2Z"/><path d="M12 9.5v4.5"/></g><circle cx="12" cy="17" r="1.4" fill="currentColor"/>',
      doubleCaution: S + '<path d="M7 5 13 17H1Z"/><path d="M17 5 23 17H11Z"/><path d="M7 9.5v3M17 9.5v3"/></g><circle cx="7" cy="15" r="1.1" fill="currentColor"/><circle cx="17" cy="15" r="1.1" fill="currentColor"/>',
      crest: S + '<path d="M2 19C7 19 8 7 12 7S17 19 22 19"/></g>',
      jumpOverBump: S + '<path d="M2 21C6 21 7 16 9.5 16S13 21 17 21H22"/><path d="M5 12C9 3 15 3 19 9" stroke-dasharray="2.4 2.4"/></g>' + head(19.5, 10, 2.4),
      bump: S + '<path d="M2 18H6C8 18 9 11 12 11S16 18 18 18H22"/></g>',
      bumps: S + '<path d="M1 18C3.5 18 4 12 6.5 12S9.5 18 12 18 14.5 12 17 12 20 18 23 18"/></g>',
      pothole: S + '<path d="M2 9H6C8 9 8 17 12 17S16 9 18 9H22"/></g>',
      water: S + '<path d="M2 9c2.5-2.5 5 2.5 7.5 0s5 2.5 7.5 0 3.5 1 5 0"/><path d="M2 16c2.5-2.5 5 2.5 7.5 0s5 2.5 7.5 0 3.5 1 5 0"/></g>',
      bridge: S + '<path d="M2 9H22M4 9V20M20 9V20M4 19C7 12 17 12 20 19"/></g>',
      narrows: S + '<path d="M5 3 10 11V21M19 3 14 11V21"/></g>',
      finish: '<path d="M4 3H20V17H4Z" fill="#fff"/><path d="M4 3h4v3.5H4zm8 0h4v3.5h-4zM8 6.5h4V10H8zm8 0h4V10h-4zM4 10h4v3.5H4zm8 0h4v3.5h-4zM8 13.5h4V17H8zm8 0h4V17h-4z" fill="#111"/><path d="M4 3V22" stroke="currentColor" stroke-width="2"/>',
      scissors: S + '<circle cx="7" cy="17.5" r="3"/><circle cx="17" cy="17.5" r="3"/><path d="M9 15.5 18.5 3M15 15.5 5.5 3"/></g>',
      scissorsSlashed: S + '<circle cx="7" cy="17.5" r="3"/><circle cx="17" cy="17.5" r="3"/><path d="M9 15.5 18.5 3M15 15.5 5.5 3"/><path d="M2 2 22 22" stroke-width="3"/></g>',
      mathLessThan: S + '<path d="M17 4 7 12 17 20" stroke-width="3.2"/></g>',
      mathGreaterThan: S + '<path d="M7 4 17 12 7 20" stroke-width="3.2"/></g>',
      dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>'
    };
  })();
  function pnTile(t) {
    if (!t) return '';
    var bgc = t.background || {}, bg = bngColor(bgc.color, '#2a2e34'), st = bngColor(bgc.strokeColor, bg);
    var fg = bngColor(t.colorNoteIcon, '#f2f2f2'), tx = bngColor(t.colorNoteText, fg);
    var h = '<div class="pn-tile' + (t.isInto ? ' into' : '') + '" style="background:' + bg + ';border-color:' + st + ';color:' + fg +
      (t.isInto ? ';--pn-into:' + bngColor(t.intoColor, st) : '') + '">' +
      '<svg viewBox="0 0 24 24" class="g"' + (t.isLeft ? ' style="transform:scaleX(-1)"' : '') + '>' + (PN_GLYPH[t.type] || PN_GLYPH.dot) + '</svg>';
    if (t.turnTypeValue) h += '<b style="color:' + tx + '">' + esc(t.turnTypeValue) + '</b>';
    if (t.turnModifier) h += '<i class="mod" style="color:' + tx + '"><svg viewBox="0 0 24 24">' + (PN_GLYPH[t.turnModifier] || '') + '</svg></i>';
    if (t.additionalNote) {
      var an = t.additionalNote;
      h += '<i class="note" style="background:' + bngColor(an.colorBg, bg) + ';border-color:' + bngColor(an.colorStroke, st) + ';color:' + bngColor(an.color, fg) + '"><svg viewBox="0 0 24 24">' + (PN_GLYPH[an.icon] || '') + '</svg></i>';
    }
    h += '</div>';
    if (t.distance) h += '<span class="pn-dist" style="color:' + bngColor(t.colorDistance, '#f2f2f2') + '">' + esc(t.distance) + '</span>';
    return h;
  }
  function pnTiles(vis, cls) { return '<div class="pn-tiles' + (cls ? ' ' + cls : '') + '">' + arr(vis).map(pnTile).join('') + '</div>'; }
  // <<< shared pacenote tiles
  // the first corner tile of a note (map pins, lists)
  function pnMain(vis) {
    var list = arr(vis);
    for (var i = 0; i < list.length; i++) if (String(list[i].type || '').indexOf('turn') === 0) return list[i];
    return list[0];
  }
  // a pacenote draft as a Lua table literal
  function luaPn(d) {
    d = d || {};
    return '{d=' + luaNum(d.d || 0) + ', c=' + luaStr(d.c || '') + (d.len ? ', len=' + luaStr(d.len) : '') + (d.sh ? ', sh=' + luaStr(d.sh) : '') +
      ', ca=' + luaNum(d.ca || 0) + ', m={' + arr(d.m).map(function (x) { return luaStr(x); }).join(', ') + '}}';
  }

  // ---------------------------------------------------------------- polyline helpers
  // Ramer-Douglas-Peucker on a flat [x,y,...] list (drawing only; Lua keeps the full-resolution course)
  function simplify(flat, eps) {
    var n = flat.length / 2;
    if (n <= 2) return flat.slice();
    var keep = new Uint8Array(n), stack = [[0, n - 1]];
    keep[0] = keep[n - 1] = 1;
    while (stack.length) {
      var se = stack.pop(), a = se[0], b = se[1];
      var ax = flat[2 * a], ay = flat[2 * a + 1], bx = flat[2 * b], by = flat[2 * b + 1];
      var dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9, best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs(dy * flat[2 * i] - dx * flat[2 * i + 1] + bx * ay - by * ax) / L;
        if (d > best) { best = d; bi = i; }
      }
      if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    var out = [];
    for (i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
    return out;
  }
  // SVG path in display coords: world (x, y) -> (x, -y), north up
  function pathD(flat, i0, i1) {
    var d = '';
    for (var i = i0; i <= i1; i++) d += (i === i0 ? 'M' : 'L') + flat[2 * i].toFixed(1) + ' ' + (-flat[2 * i + 1]).toFixed(1);
    return d;
  }
  // sharp-turn segments of a course (Tread "highlight sharp turns"): returns { 1: [[i,j]...], 2: ..., 3: ... }
  function sharpTurns(flat) {
    var n = flat.length / 2, cum = new Float64Array(n), out = { 1: [], 2: [], 3: [] };
    if (n < 3) return out;
    for (var i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(flat[2 * i] - flat[2 * i - 2], flat[2 * i + 1] - flat[2 * i - 1]);
    var lv = new Int8Array(n), a = 0, b = 0, W = 15;
    for (i = 0; i < n; i++) {
      while (a < i && cum[i] - cum[a + 1] >= W) a++;
      while (b < n - 1 && cum[b] - cum[i] < W) b++;
      if (a === i || b === i) continue;
      var x1 = flat[2 * i] - flat[2 * a], y1 = flat[2 * i + 1] - flat[2 * a + 1];
      var x2 = flat[2 * b] - flat[2 * i], y2 = flat[2 * b + 1] - flat[2 * i + 1];
      var l1 = Math.hypot(x1, y1), l2 = Math.hypot(x2, y2);
      if (l1 < 5 || l2 < 5) continue;
      var ang = Math.acos(Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2) / (l1 * l2)))) * 180 / Math.PI;
      lv[i] = ang >= 95 ? 3 : ang >= 65 ? 2 : ang >= 40 ? 1 : 0;
    }
    for (var L = 1; L <= 3; L++) {
      var start = -1;
      for (i = 0; i <= n; i++) {
        var on = i < n && lv[i] >= L;
        if (on && start < 0) start = i;
        if (!on && start >= 0) { out[L].push([Math.max(0, start - 1), Math.min(n - 1, i)]); start = -1; }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- WorldView: our own base map
  // Display coords are world metres with Y flipped (north up). One <svg> inside a <div> holds every world layer;
  // the div gets one CSS transform per frame:  translate(anchor) rotate(theta) scale(zoom / k) translate(-vehicle).
  function WorldView(host) {
    this.host = host;
    this.layer = document.createElement('div');
    this.layer.className = 'txl-world';
    host.appendChild(this.layer);
    this.svg = svgEl('svg', { class: 'txl-worldsvg' });
    this.layer.appendChild(this.svg);
    this.gBg = svgEl('g', { class: 'w-bg' }, this.svg);
    this.gTerrain = svgEl('g', { class: 'w-terrain' }, this.svg);
    this.gRoads = svgEl('g', { class: 'w-roads' }, this.svg);
    this.gRings = svgEl('g', { class: 'w-rings' }, this.svg);
    this.gTrail = svgEl('g', { class: 'w-trail' }, this.svg);
    this.gCourse = svgEl('g', { class: 'w-course' }, this.svg);
    this.bounds = {};          // name -> [x0, y0, x1, y1] display coords
    this.ext = null;           // current svg extent
    this.k = 1;                // svg px per metre
    this.cam = null;
    this.strokeZoom = 0;
    this.info = { source: 'none', segments: 0, terrain: false };
  }
  WorldView.prototype.setBounds = function (name, b) {
    if (b) this.bounds[name] = b; else delete this.bounds[name];
    var u = null;
    for (var k in this.bounds) {
      var v = this.bounds[k];
      u = u ? [Math.min(u[0], v[0]), Math.min(u[1], v[1]), Math.max(u[2], v[2]), Math.max(u[3], v[3])] : v.slice();
    }
    if (!u) return;
    var e = this.ext;
    if (e && u[0] >= e[0] && u[1] >= e[1] && u[2] <= e[2] && u[3] <= e[3]) return; // grow only
    var M = 500, r = function (v, up) { return (up ? Math.ceil(v / 250) : Math.floor(v / 250)) * 250; };
    e = [r(u[0] - M), r(u[1] - M), r(u[2] + M, true), r(u[3] + M, true)];
    if (this.ext) e = [Math.min(e[0], this.ext[0]), Math.min(e[1], this.ext[1]), Math.max(e[2], this.ext[2]), Math.max(e[3], this.ext[3])];
    this.ext = e;
    var w = e[2] - e[0], h = e[3] - e[1];
    this.k = Math.max(0.02, Math.min(1, 4096 / Math.max(w, h)));
    this.svg.setAttribute('viewBox', e[0] + ' ' + e[1] + ' ' + w + ' ' + h);
    this.svg.setAttribute('width', (w * this.k).toFixed(0));
    this.svg.setAttribute('height', (h * this.k).toFixed(0));
    this.svg.style.width = (w * this.k).toFixed(0) + 'px';
    this.svg.style.height = (h * this.k).toFixed(0) + 'px';
    this.drawBackground();
  };
  // sand + 250 m grid where there's no terrain image
  WorldView.prototype.drawBackground = function () {
    var g = this.gBg, e = this.ext;
    while (g.firstChild) g.removeChild(g.firstChild);
    if (!e) return;
    svgEl('rect', { x: e[0], y: e[1], width: e[2] - e[0], height: e[3] - e[1], class: 'w-sand' }, g);
    if (this.info.terrain) return;
    var d = '';
    for (var x = e[0]; x <= e[2]; x += 250) d += 'M' + x + ' ' + e[1] + 'V' + e[3];
    for (var y = e[1]; y <= e[3]; y += 250) d += 'M' + e[0] + ' ' + y + 'H' + e[2];
    svgEl('path', { d: d, class: 'w-grid', 'data-px': 1 }, g);
    this.strokeZoom = 0;
  };
  WorldView.prototype.clearBase = function () {
    var self = this;
    [this.gTerrain, this.gRoads].forEach(function (g) { while (g.firstChild) g.removeChild(g.firstChild); });
    this.info = { source: 'none', segments: 0, terrain: false };
    delete this.bounds.roads; delete this.bounds.terrain;
    this.drawBackground();
    self.strokeZoom = 0;
  };
  // terrain image tiles from Lua: x = west edge, y = north edge, w / h in metres (north is the top of the image)
  WorldView.prototype.setTerrainTiles = function (tiles) {
    var g = this.gTerrain, b = null, n = 0;
    while (g.firstChild) g.removeChild(g.firstChild);
    arr(tiles).forEach(function (t) {
      var x = Number(t && t.x), y = Number(t && t.y), w = Number(t && t.w), h = Number(t && t.h);
      if (!t || !t.image || !isFinite(x) || !isFinite(y) || !(w > 0) || !(h > 0)) return;
      var url = String(t.image).charAt(0) === '/' ? String(t.image) : '/' + t.image;
      setHref(svgEl('image', { x: x, y: -y, width: w, height: h, preserveAspectRatio: 'none', class: t.height ? 'w-height' : null }, g), url);
      var tb = [x, -y, x + w, -y + h];
      b = b ? [Math.min(b[0], tb[0]), Math.min(b[1], tb[1]), Math.max(b[2], tb[2]), Math.max(b[3], tb[3])] : tb;
      n++;
    });
    this.info.terrain = n > 0;
    this.info.tiles = n;
    this.setBounds('terrain', b);
    this.drawBackground();
  };
  // segs: flat [x1, y1, x2, y2, radius, class, ...] world coords; class 0 = trail, 1 = dirt road, 2 = paved
  WorldView.prototype.setRoads = function (segs, source) {
    var g = this.gRoads;
    while (g.firstChild) g.removeChild(g.firstChild);
    var buckets = {}, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (var i = 0; i + 5 < segs.length; i += 6) {
      var x1 = segs[i], y1 = -segs[i + 1], x2 = segs[i + 2], y2 = -segs[i + 3];
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;
      var r = Math.round(Math.max(0.5, Math.min(8, segs[i + 4] || 2)) * 2) / 2, cls = segs[i + 5];
      var key = cls + '_' + r;
      var b = buckets[key] || (buckets[key] = { cls: cls, r: r, d: [] });
      b.d.push('M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1));
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2); minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      n++;
    }
    var list = Object.keys(buckets).map(function (k) { return buckets[k]; });
    list.sort(function (a, b) { return a.cls - b.cls || a.r - b.r; });
    var self = this;
    // paved roads get a darker casing underneath
    list.forEach(function (b) {
      if (b.cls === 2) svgEl('path', { d: b.d.join(''), class: 'w-road-case', 'data-m': (b.r * 2 + 1.6).toFixed(1), 'data-minpx': 3 }, g);
    });
    list.forEach(function (b) {
      svgEl('path', {
        d: b.d.join(''), class: b.cls === 0 ? 'w-trailroad' : b.cls === 1 ? 'w-dirt' : 'w-paved',
        'data-m': (b.r * 2).toFixed(1), 'data-minpx': b.cls === 2 ? 1.6 : 1.2, 'data-dashpx': b.cls === 0 ? '5 3' : null
      }, g);
    });
    this.info.source = source || 'game';
    this.info.segments = n;
    if (n) this.setBounds('roads', [minX, minY, maxX, maxY]);
    this.strokeZoom = 0;
  };
  // from our Lua: { pts: [x, y, r, ...], edges: [a, b, drivability*100, ...], tiles: [{image, x, y, w, h}] }
  WorldView.prototype.setCompactMap = function (d) {
    var p = arr(d && d.pts), e = arr(d && d.edges), segs = [];
    for (var i = 0; i + 2 < e.length; i += 3) {
      var a = e[i] * 3, b = e[i + 1] * 3, dr = (e[i + 2] || 100) / 100;
      if (a + 2 >= p.length || b + 2 >= p.length) continue;
      segs.push(p[a], p[a + 1], p[b], p[b + 1], (p[a + 2] + p[b + 2]) / 2, dr <= 0.1 ? 0 : dr < 0.9 ? 1 : 2);
    }
    this.setTerrainTiles(d && d.tiles);
    this.setRoads(segs, 'roadgraph');
  };
  // world strokes are in metres; keep them a constant on-screen width as the zoom changes
  WorldView.prototype.updateStrokes = function (zoom) {
    if (this.strokeZoom && Math.abs(zoom / this.strokeZoom - 1) < 0.08) return;
    this.strokeZoom = zoom;
    var els = this.svg.querySelectorAll('[data-px],[data-m]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], px = el.getAttribute('data-px');
      var w = px != null ? Number(px) / zoom : Math.max(Number(el.getAttribute('data-m')), Number(el.getAttribute('data-minpx') || 1) / zoom);
      el.setAttribute('stroke-width', w.toFixed(3));
      var dash = el.getAttribute('data-dashpx');
      if (dash) el.setAttribute('stroke-dasharray', dash.split(' ').map(function (v) { return (Number(v) / zoom).toFixed(2); }).join(' '));
    }
    // re-rasterise the composited layer at the new scale (stays sharp after zooming)
    var layer = this.layer;
    layer.style.willChange = 'auto';
    setTimeout(function () { layer.style.willChange = 'transform'; }, 60);
  };
  WorldView.prototype.setCamera = function (cx, cy, headingDeg, northUp, zoom, ax, ay) {
    this.cam = { x: cx, y: cy, h: headingDeg, z: zoom, ax: ax, ay: ay, th: northUp ? 0 : -headingDeg };
    var e = this.ext;
    if (!e) { this.layer.style.visibility = 'hidden'; return; }
    this.layer.style.visibility = 'visible';
    var px = (cx - e[0]) * this.k, py = (-cy - e[1]) * this.k;
    this.layer.style.transform = 'translate(' + ax.toFixed(2) + 'px,' + ay.toFixed(2) + 'px) rotate(' + this.cam.th.toFixed(3) +
      'deg) scale(' + (zoom / this.k).toFixed(6) + ') translate(' + (-px).toFixed(2) + 'px,' + (-py).toFixed(2) + 'px)';
    this.updateStrokes(zoom);
  };
  WorldView.prototype.toLocal = function (x, y) {
    var c = this.cam, t = c.th * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    var dx = (x - c.x) * c.z, dy = -(y - c.y) * c.z;
    return [c.ax + dx * co - dy * si, c.ay + dx * si + dy * co];
  };
  WorldView.prototype.toWorld = function (X, Y) {
    var c = this.cam, t = c.th * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    var dx = X - c.ax, dy = Y - c.ay;
    return [c.x + (dx * co + dy * si) / c.z, c.y - (-dx * si + dy * co) / c.z];
  };

  // ---------------------------------------------------------------- the app
  function TreadXLApp(root, env) {
    this.root = root;
    this.env = env || {};
    this.isDash = !!this.env.dash; // v3.2: the copy drawn on the vehicle's screen (dash.html): display only
    this.s = loadSettings();
    if (this.isDash) { this.s.bezel = false; this.s.dash = false; }
    if (!shownIcon(this.s.markIcon)) this.s.markIcon = ONYX ? 'Tread_XL_icon_warning.svg' : 'Tread_XL_icon_checkpoint.svg'; // the edition's own symbols
    if (/youtube\.com|youtu\.be|youtube-nocookie/i.test(String(this.s.videoPage || ''))) this.s.videoPage = ''; // a video link pasted into the page box (v2.7.04)
    // the video pages BeamNG's screen refused, kept between sessions (a copy: never the DEFAULTS object itself)
    var vb = this.s.videoBlocked;
    this.s.videoBlocked = vb && typeof vb === 'object' && !Array.isArray(vb) ? { own: typeof vb.own === 'string' ? vb.own : undefined, web: vb.web ? 1 : undefined, local: vb.local ? 1 : undefined } : {};
    for (var vk in this.s.videoBlocked) if (this.s.videoBlocked[vk] === undefined) delete this.s.videoBlocked[vk];
    this.hud = null;
    this.course = null;       // { name, source, readOnly, length, flat, wpts, zones }
    this.wpts = { owner: null, wpts: [] };
    this.trail = [];
    this.rec = { active: false };
    this.routes = [];
    this.gpxFiles = [];
    this.paths = {};
    this.mapName = '';
    this.icons = ICONS.map(function (i) { return i.file; }).filter(shownIcon);
    this.chaseTargets = [];
    this.chaseCurrent = null;
    this.pan = [0, 0];
    this.sheet = null;
    this.menuTab = 'courses';
    this.sel = null;          // selected course key in MENU > Courses
    this.renaming = null;     // course key being renamed
    this.renameText = '';
    this.recName = '';
    this.armed = null;        // two-tap delete
    this.lastHtml = {};
    this.worldKey = '';
    this.camState = null;
    this.zoomFactor = 1;
    this.mapAttempt = 0;
    this.mapState = 'loading';
    this.toastTimer = null;
    this.courseInfo = {};     // course key -> notes / picture / best time
    this.pnInfo = null;       // pacenote builder catalogue + co-driver voices (from Lua)
    this.pnPreview = null;    // tiles + text of the pacenote being built
    this.dark = false;
    this.booting = true;
    this.bootT0 = Date.now();
    this.hello = null;        // answer from the game-side script (version, level)
    this.helloTries = 0;
    this.hudSeen = false;
    this.destroyed = false;
    this.build();
    this.mediaInit();
    this.applySettings();
    this.loop = this.loop.bind(this);
    this.lastFrame = 0;
    this.raf = window.requestAnimationFrame(this.loop);
    var self = this;
    this.clockTimer = setInterval(function () { self.renderStatus(); }, 5000);
    // v3.3: pass alerts go to the screens that are visible: this one says so every second
    this.passHandle = 'nav-' + Math.random().toString(36).slice(2, 10);
    this.passShownIds = {}; this.passShownN = 0;
    if (!this.isDash && !ONYX) this.passTimer = setInterval(function () { self.passReport(); }, 1000);
    this.lua('if not TreadXLGPS then extensions.load("TreadXLGPS") end');
    this.lua('if TreadXLGPS and TreadXLGPS.setSound then TreadXLGPS.setSound(' + (this.s.sound ? 'true' : 'false') + ') end');
    this.pushPacenoteOptions();
    this.lua('if TreadXLGPS then TreadXLGPS.setChaseInterval(' + luaNum(this.s.chaseInterval) + ') end');
    this.pushMarkDefaults();
    this.call('requestState');
    this.call('requestMedia');
    this.mapTimer = setTimeout(function () { self.requestMap(false); }, 300);
    this.helloTimer = setTimeout(function () { self.checkHello(); }, 4000);
    this.bootTimer = setInterval(function () { self.bootCheck(); }, 300);
    this.renderAll();
  }
  window.TreadXLApp = TreadXLApp;
  TreadXLApp.pnTile = pnTile; // for the dev previews
  TreadXLApp.WorldView = WorldView;
  TreadXLApp.luaStr = luaStr;
  TreadXLApp.fmtDist = fmtDist;

  var P = TreadXLApp.prototype;

  P.lua = function (code) { try { if (this.env.lua) this.env.lua(code); } catch (_) { } };
  P.pushPacenoteOptions = function () {
    var s = this.s;
    this.lua('if TreadXLGPS and TreadXLGPS.setPacenoteOptions then TreadXLGPS.setPacenoteOptions({calls=' + luaStr(s.pnCalls) + ', lead=' + luaStr(s.pnLead) +
      ', native=' + (s.pnNative ? 'true' : 'false') + ', style=' + luaStr(capsOf(s.mode).calls === 'chase' ? 'chase' : 'full') + (s.pnVoice ? ', voice=' + luaStr(s.pnVoice) : '') + '}) TreadXLGPS.setOffCourseAlert(' + luaNum(Number(s.offCourseM) || 15) + ')' +
      ' if TreadXLGPS.setDamageLog then TreadXLGPS.setDamageLog(' + (s.damageLog ? 'true' : 'false') + ') end end');
  };
  P.call = function (fn, args) { this.lua('if TreadXLGPS then TreadXLGPS.' + fn + '(' + (args || '') + ') end'); };
  P.save = function () { if (this.isDash) return; saveSettings(this.s); this.dashSync(); }; // the vehicle's screen never writes the unit's settings
  // v3.2: the vehicle's screen shows a copy of this unit; it gets these settings and what's open (home screen)
  P.dashSync = function () {
    if (this.isDash || !this.s.dash) return;
    var json = JSON.stringify({ settings: this.s, view: { home: !!this.home } }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    if (json === this.dashLast) return;
    this.dashLast = json;
    this.call('dashSync', luaStr(json));
  };
  // ...on the vehicle's screen (dash.html)
  P.dashSettings = function (st) {
    if (!st || typeof st !== 'object') return;
    for (var k in st) if (k in DEFAULTS && typeof st[k] === typeof DEFAULTS[k]) this.s[k] = st[k];
    this.s.bezel = false; this.s.dash = false;
    this.applySettings(); this.renderMedia(); this.renderAll();
  };
  P.dashView = function (v) { if (v && typeof v.home === 'boolean' && v.home !== !!this.home) this.showHome(v.home); };
  // the pop-up: the HUD app opens big in the middle of the view (dash click or key), and back
  P.togglePop = function (on) {
    if (!this.s.dash) { this.toast('Turn on MENU \u203a Display \u203a On the vehicle\u2019s screen first', 'info'); return; }
    this.pop = typeof on === 'boolean' ? on : !this.pop;
    this.root.setAttribute('data-pop', this.pop ? '1' : '0');
    var self = this;
    setTimeout(function () { self.resize(); self.renderAll(); }, 30);
  };

  // ---------------------------------------------------------------- DOM
  P.build = function () {
    var r = this.root;
    r.classList.add('txl');
    r.setAttribute('data-zip', EDITION); // the zip's own edition: the Onyx Edition's theme
    r.innerHTML = [
      '<div class="txl-device">',
      ' <div class="txl-sensor"></div>',
      ' <div class="txl-screen">',
      '  <div class="txl-map"><div class="txl-maphint"></div></div>',
      '  <div class="txl-status"><div class="txl-sl"></div><div class="txl-modetxt"></div><div class="txl-trial"></div><div class="txl-clock"></div><div class="txl-icons"></div></div>',
      '  <div class="txl-deck"></div>',
      '  <div class="txl-mbar"><button class="mb-art" data-act="mbarOpen" title="Open the music player">' + G.note + '</button><button class="mb-txt" data-act="mbarOpen"><div class="mb-t"></div><div class="mb-s"></div></button>' +
      '<div class="mb-ctl"><button class="mb-b prev" data-act="musPrev" title="Previous">\u23ee</button><button class="mb-b play" data-act="musToggle" title="Play / pause"></button><button class="mb-b" data-act="musNext" title="Next">\u23ed</button></div><i class="mb-prog"><b></b></i></div>',
      '  <div class="txl-fields"></div>',
      '  <div class="txl-alert"></div>',
      '  <div class="txl-chips"></div>',
      '  <div class="txl-pnbar"></div>',
      '  <div class="txl-count"></div>',
      '  <div class="txl-result"></div>',
      '  <div class="txl-speed"><div class="txl-speedbox"><div class="v">0</div><div class="u">MPH</div></div><div class="txl-limit"><div class="t">SPEED<br>LIMIT</div><div class="n">35</div></div><div class="txl-scale"><span></span><i></i></div></div>',
      '  <div class="txl-mapbtns">',
      '   <button class="txl-mbtn" data-act="zoomIn" title="Zoom in"><span class="glyph">+</span></button>',
      '   <button class="txl-mbtn" data-act="zoomOut" title="Zoom out"><span class="glyph">\u2212</span></button>',
      '   <button class="txl-mbtn" data-act="orient" title="Track up / North up"><div class="orient">' + G.needle + '<span></span></div></button>',
      '   <button class="txl-mbtn center" data-act="center" title="Center the map on your vehicle">' + G.chase + '</button>',
      '  </div>',
      '  <div class="txl-actions">',
      '   <button class="txl-abtn racebtn hidden" data-act="raceGo" title="Race this route"></button>',
      '   <button class="txl-abtn passbtn hidden" data-act="passReq" title="Ask the drivers within 100 m to let you pass">' + G.pass + '<span>PASS</span></button>',
      '   <button class="txl-abtn recbtn" data-act="recToggle" title="Start / stop recording a course"></button>',
      '   <button class="txl-abtn mark" data-act="mark">' + G.mark + '<span>MARK</span></button>',
      '   <button class="txl-abtn undo" data-act="undoMark" title="Remove the last waypoint marked on this recording">' + G.undo + '<span>UNDO</span></button>',
      '   <button class="txl-abtn" data-act="chase">' + G.chase + '<span>CHASE</span></button>',
      '   <button class="txl-abtn" data-act="menu">' + G.menu + '<span>MENU</span></button>',
      '  </div>',
      '  <button class="txl-pipcap" data-act="pipMap" title="Full map (drag to move the map)"></button><button class="txl-piprc" data-act="center" title="Center the map on your vehicle">' + G.chase + '</button>',
      '  <div class="txl-media">',
      '   <div class="md-head"><b class="md-title"></b><span class="md-sub"></span><span class="grow"></span>',
      '    <button class="md-btn swap" data-act="mediaSwap" title="Video / music"></button><button class="md-btn split" data-act="mediaSplit" title="Full screen / split screen"></button><button class="md-btn x" data-act="mediaClose" title="Back to the map">' + G.close + '</button></div>',
      '   <div class="md-video">',
      '    <div class="mv-url"><input class="txl-input" type="text" data-in="videoUrl" data-enter="vidGo" maxlength="500" placeholder="Paste a YouTube link (or pick one of your videos below)">' + kbd('videoUrl') + '<button class="txl-btn blue" data-act="vidPaste">PASTE</button><button class="txl-btn primary" data-act="vidGo">PLAY</button></div>',
      '    <div class="mv-stage"><div class="mv-msg"></div></div><div class="mv-wake"></div>',
      '    <div class="mc-row mv-ctl"><button class="mc-b" data-act="vidBack" title="Back 10 s">\u221210</button><button class="mc-b play" data-act="vidPlay" title="Play / pause"></button><button class="mc-b" data-act="vidFwd" title="Forward 10 s">+10</button>' +
      '<span class="mc-t cur">0:00</span><input class="mc-seek" type="range" data-in="vidSeek" min="0" max="1000" value="0"><span class="mc-t dur">0:00</span>' +
      '<button class="mc-b mute" data-act="mediaMute" title="Mute"></button><input class="mc-vol" type="range" data-in="mediaVol" min="0" max="1" step="0.05"><button class="mc-b" data-act="vidBrowser" title="Open the link in your browser">WEB</button>' +
      '<button class="mc-b vsplit" data-act="mediaSplit" title="Full screen: the whole screen or the split side">SPLIT</button><button class="mc-b vfull" data-act="vidFull" title="Full screen video"></button></div>',
      '    <div class="mv-list"></div>',
      '   </div>',
      '   <div class="md-music">',
      '    <div class="mm-now"></div>',
      '    <div class="mc-row mm-ctl"><button class="mc-b" data-act="musPrev" title="Previous">\u23ee</button><button class="mc-b play" data-act="musToggle" title="Play / pause"></button><button class="mc-b" data-act="musNext" title="Next">\u23ed</button>' +
      '<span class="mc-t cur">0:00</span><input class="mc-seek" type="range" data-in="musSeek" min="0" max="1000" value="0"><span class="mc-t dur">0:00</span>' +
      '<button class="mc-b mute" data-act="mediaMute" title="Mute"></button><input class="mc-vol" type="range" data-in="mediaVol" min="0" max="1" step="0.05"></div>',
      '    <div class="mm-opts"></div>',
      '    <div class="mm-list"></div>',
      '   </div>',
      '   <div class="md-gauges"></div>',
      '  </div>',
      '  <div class="txl-toast"></div>',
      '  <div class="txl-banner"></div>',
      '  <div class="txl-sheet" data-sheet="menu"></div>',
      '  <div class="txl-sheet" data-sheet="mark"></div>',
      '  <div class="txl-sheet" data-sheet="chase"></div>',
      '  <div class="txl-sheet" data-sheet="unlock"></div>',
      '  <div class="txl-sheet" data-sheet="notice"></div>',
      '  <div class="txl-sheet" data-sheet="login"></div>',
      ('  <div class="txl-home"><div class="h-top"><div class="h-clock"></div><div class="h-date"></div></div><div class="h-tiles">' +
        [['music', 'Music', G.hMusic], ['video', 'Video', G.hVideo], ['maps', 'Maps', G.hMaps], ['settings', 'Settings', G.hSettings], ['gallery', 'Gallery', G.hGallery]].map(function (t) {
          return '<button class="h-tile" data-act="homeGo" data-v="' + t[0] + '"><i>' + t[2] + '</i><span>' + t[1] + '</span></button>';
        }).join('') + '</div>' + (ONYX ? '<img class="h-gem" src="' + APP_DIR + 'onyx/gem.svg" alt="">' : '') + '</div>'),
      '  <div class="txl-pass" aria-live="polite"></div>',
      '  <div class="txl-gal"><div class="g-head"><b>GALLERY</b><span class="g-n"></span><span class="grow"></span><button class="txl-btn" data-act="openFolder" data-v="screenshots">OPEN FOLDER</button><button class="txl-btn g-x" data-act="galClose" title="Close">\u2715</button></div><div class="g-grid"></div><div class="g-pg"></div></div>',
      '  <div class="txl-galview"><img alt=""><div class="gv-bar"><button class="gv-b" data-act="galPrev" title="Previous">\u2039</button><span class="gv-n"></span><button class="gv-b" data-act="galNext" title="Next">\u203a</button><button class="gv-b" data-act="galViewClose" title="Back to the gallery">\u2715</button></div></div>',
      '  <div class="txl-nudge"><div class="n-t">Access to other features requires the product key to unlock it.</div><div class="n-s">Contact Baja75 on Patreon for assistance.</div><div class="n-b"><button class="txl-btn primary" data-act="nudgeKey">ENTER KEY</button><button class="txl-btn" data-act="nudgeClose">OK</button></div></div>',
      '  <div class="txl-dead"><div class="d-t">This unit is disabled</div><div class="d-s">Contact Baja75 Support to unlock it. Take a screenshot of this screen and send it with your request.</div>' + '<button class="txl-btn primary" data-act="keyOpen">ENTER KEY</button></div>',
      '  <div class="txl-boot show"><div class="b-logo"><img src="' + APP_DIR + (ONYX ? 'onyx/logo.svg' : 'logo.png') + '" alt="' + (ONYX ? 'Onyx Edition' : 'Baja75 Navigation Unit') + '"></div><div class="b-sub">10\u2033 ' + (ONYX ? 'OVERLAND' : 'OFF-ROAD') + ' NAVIGATOR' + (EDITION_NAME ? ' \u00b7 ' + EDITION_NAME.toUpperCase() : '') + '</div><div class="b-bar"><i></i></div><div class="b-txt">Loading map\u2026</div><div class="b-info"></div></div>',
      '  <div class="txl-off"></div>',
      '  <div class="txl-glare"></div>',
      ' </div>',
      ' <div class="txl-case"><i class="g tl"></i><i class="g tr"></i><i class="g bl"></i><i class="g br"></i><i class="sc l1"></i><i class="sc l2"></i><i class="sc r1"></i><i class="sc r2"></i><span class="b75">B75<small>v' + VERSION + (EDITION_TAG ? ' - ' + EDITION_TAG : '') + '</small></span></div>',
      ' <div class="txl-brand"><img class="txl-logo" src="' + APP_DIR + (ONYX ? 'onyx/logo.svg' : 'logo.png') + '" alt="' + (ONYX ? 'Onyx Edition' : 'Baja75 Navigation Unit') + '"><b></b></div>',
      ' <div class="txl-hw">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<button class="txl-hwb' + (n > 2 ? ' off' : '') + '" data-act="hw" data-v="' + n + '" title="' + (n === 2 ? 'Display: map / video / music (/ gauges in Track)' : n > 2 ? 'Button ' + n + ' (not used yet)' : '') + '">' +
          '<span>' + (n === 2 ? 'DISPLAY' : '') + '</span></button>';
      }).join('') + '</div>',
      ' <button class="txl-pwr" data-act="power" data-tip="Restart System" aria-label="Restart System">' + G.pwr + '</button>',
      ' <div class="txl-led"></div>',
      ' <button class="txl-popx" data-act="popClose" title="Back to the dash">BACK TO DASH \u2715</button>',
      ' <div class="txl-bsod"><div class="e-h">BAJA75 NAVIGATION UNIT</div><div class="e-p">A fatal exception has occurred and the navigation system has been halted to prevent damage to your saved courses.</div>' +
      '<div class="e-p e-code">STOP: 0x000000B7 (0x00000047, 0x4E415653, 0x00000000, 0x00000000)<br>NAV_SYSTEM_INTEGRITY_FAULT</div>' +
      '<div class="e-p">* Restarting the unit or the game will not clear this error.<br>* If this keeps happening, contact Baja75 on Patreon.</div>' +
      '<div class="e-p e-dump">Collecting error data\u2026 100% complete</div></div>',
      '</div>'
    ].join('');
    var q = function (sel) { return r.querySelector(sel); };
    this.el = {
      device: q('.txl-device'), screen: q('.txl-screen'), map: q('.txl-map'), hint: q('.txl-maphint'),
      clock: q('.txl-clock'), mode: q('.txl-modetxt'), icons: q('.txl-icons'), trial: q('.txl-trial'), dead: q('.txl-dead'), bootSub: q('.b-sub'), nudge: q('.txl-nudge'), home: q('.txl-home'),
      deck: q('.txl-deck'), fields: q('.txl-fields'), alert: q('.txl-alert'), speedbox: q('.txl-speedbox'),
      limit: q('.txl-limit'), scale: q('.txl-scale'), orient: q('.orient'), center: q('[data-act="center"]'),
      chaseBtn: q('[data-act="chase"]'), recBtn: q('[data-act="recToggle"]'), toast: q('.txl-toast'), banner: q('.txl-banner'),
      chips: q('.txl-chips'), pnbar: q('.txl-pnbar'), count: q('.txl-count'), result: q('.txl-result'), boot: q('.txl-boot'), raceBtn: q('[data-act="raceGo"]'),
      actions: q('.txl-actions'), media: q('.txl-media'), pass: q('.txl-pass'), gal: q('.txl-gal'), galView: q('.txl-galview'), passBtn: q('[data-act="passReq"]'), brandTag: q('.txl-brand b'), mbar: q('.txl-mbar'),
      sheets: { menu: q('[data-sheet="menu"]'), mark: q('[data-sheet="mark"]'), chase: q('[data-sheet="chase"]'), unlock: q('[data-sheet="unlock"]'), notice: q('[data-sheet="notice"]'), login: q('[data-sheet="login"]') }
    };
    // stylesheet (legacy apps don't load app.css on their own in every game version)
    if (!document.getElementById('txl-css')) {
      var link = document.createElement('link');
      link.id = 'txl-css'; link.rel = 'stylesheet'; link.href = APP_DIR + 'app.css';
      document.head.appendChild(link);
    }
    // our base map + course layers, then the screen-space overlay (symbols, chase target, my arrow)
    this.view = new WorldView(this.el.map);
    var ovl = svgEl('svg', { class: 'txl-ovl' });
    this.el.map.appendChild(ovl);
    this.ov = {
      svg: ovl,
      others: svgEl('g', { class: 'others' }, ovl),
      pins: svgEl('g', { class: 'pins' }, ovl),
      start: svgEl('g', { class: 'start', visibility: 'hidden' }, ovl),
      chase: svgEl('g', { class: 'chase' }, ovl),
      me: svgEl('g', { class: 'me' }, ovl),
      xhair: svgEl('g', { class: 'xhair', visibility: 'hidden' }, ovl)
    };
    svgEl('line', { x1: -11, y1: 0, x2: 11, y2: 0 }, this.ov.xhair); svgEl('line', { x1: 0, y1: -11, x2: 0, y2: 11 }, this.ov.xhair);
    svgEl('line', { x1: -11, y1: 0, x2: 11, y2: 0 }, this.ov.xhair); svgEl('line', { x1: 0, y1: -11, x2: 0, y2: 11 }, this.ov.xhair);
    var meImg = svgEl('image', { width: 30, height: 30, x: -15, y: -15 }, this.ov.me);
    setHref(meImg, APP_DIR + 'vehicleMarker.svg');
    this.bindEvents();
  };

  P.bindEvents = function () {
    var self = this, r = this.root, map = this.el.map;
    this.onClick = function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !r.contains(t)) return;
      ev.preventDefault();
      self.act(t.getAttribute('data-act'), t);
    };
    r.addEventListener('click', this.onClick);
    // drag to pan, wheel to zoom
    var drag = null;
    this.onMove = function (ev) {
      if (!drag) return;
      self.pan = [drag.px + ev.clientX - drag.x, drag.py + ev.clientY - drag.y];
      self.updatePanUi();
    };
    this.onUp = function (ev) {
      if (!drag) return;
      var moved = ev && Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 5;
      if (moved && drag.pip) self.pipDragAt = Date.now(); // (the click that ends a drag doesn't open the full map)
      if (!moved && !drag.pip) self.revealButtons();
      drag = null; map.classList.remove('dragging');
      document.removeEventListener('mousemove', self.onMove, true);
      document.removeEventListener('mouseup', self.onUp, true);
    };
    map.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, px: self.pan[0], py: self.pan[1] };
      map.classList.add('dragging');
      document.addEventListener('mousemove', self.onMove, true);
      document.addEventListener('mouseup', self.onUp, true);
      ev.preventDefault();
    });
    map.addEventListener('wheel', function (ev) { ev.preventDefault(); self.zoom(ev.deltaY < 0 ? 1 : -1); }, { passive: false });
    // v3.4: the map in the corner of the video: drag it to look around (every edition but Free / Common)
    var cap = r.querySelector('.txl-pipcap');
    if (cap) {
      cap.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0 || !PLUS()) return;
        drag = { x: ev.clientX, y: ev.clientY, px: self.pan[0], py: self.pan[1], pip: true };
        map.classList.add('dragging');
        document.addEventListener('mousemove', self.onMove, true);
        document.addEventListener('mouseup', self.onUp, true);
        ev.preventDefault();
      });
      cap.addEventListener('wheel', function (ev) { if (!PLUS()) return; ev.preventDefault(); self.zoom(ev.deltaY < 0 ? 1 : -1); }, { passive: false });
    }
    // typing: BeamNG hands the keyboard to the UI by itself while a text box has focus, so the app never intercepts
    // keys. Enter runs the box's action; Escape lets go of the box (the keys go back to driving).
    r.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (!t || t.tagName !== 'INPUT' || !r.contains(t)) return;
      if (ev.key === 'Enter' && t.getAttribute('data-enter')) { ev.preventDefault(); self.onInput(t, true); self.act(t.getAttribute('data-enter'), t); }
      else if (ev.key === 'Escape') { t.blur(); }
    });
    r.addEventListener('input', function (ev) { self.onInput(ev.target); });
    r.addEventListener('change', function (ev) { self.onInput(ev.target, true); });
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(function () { self.resize(); });
      this.ro.observe(r);
    }
  };

  // ---------------------------------------------------------------- map data + camera
  // ask our Lua for the base map until it arrives (it answers with the map, or with why it can't yet)
  P.requestMap = function (reset) {
    var self = this;
    clearTimeout(this.mapTimer);
    if (reset) { this.mapAttempt = 0; this.mapState = 'loading'; this.mapReason = ''; this.view.clearBase(); }
    if (this.mapState === 'roads') return;
    this.mapAttempt++;
    this.call('requestBaseMap', luaNum(this.mapAttempt));
    this.mapTimer = setTimeout(function () { self.requestMap(false); }, this.mapAttempt < 4 ? 1500 * this.mapAttempt : 10000);
    this.renderMapHint();
  };
  // power-on screen: shown again whenever a map is joined
  P.startBoot = function (short) {
    var self = this;
    this.bootLoadMs = short ? BOOT_RESTART_LOAD : 0; // the power button: a short start
    this.bootReadMs = short ? BOOT_RESTART_READ : 0;
    this.booting = true;
    this.bootFull = true;
    this.bootReady = false;
    this.bootT0 = Date.now();
    this.el.boot.classList.add('show');
    this.el.boot.classList.remove('ready');
    clearInterval(this.bootTimer);
    this.bootTimer = setInterval(function () { self.bootCheck(); }, 250);
    this.bootCheck();
  };
  // the power button: the screen goes dark, then starts again (short power-on screen + chime) and asks the game
  // for everything afresh: map, courses, race, media. The game script keeps running, so a timed run carries on.
  P.restartSystem = function () {
    if (this.restarting || this.destroyed) return;
    var self = this, snd = (this.hello && this.hello.startupSound) || this.chimeUrl;
    this.restarting = true;
    if (this.s.themeNext) { this.s.theme = this.s.themeNext; this.s.themeNext = ''; this.save(); } // v3.1.9: the chosen theme, on the restart
    this.root.setAttribute('data-fade', '1'); // the whole unit (case and screen) fades to black, and back in
    try { this.videoStop(); } catch (_) { }
    try { if (this.audio && !this.audio.paused) this.audio.pause(); } catch (_) { }
    this.vfull = false;
    this.openSheet(null);
    this.root.setAttribute('data-off', '1');
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(function () {
      if (self.destroyed) return;
      self.restarting = false;
      self.root.setAttribute('data-off', '0');
      self.root.setAttribute('data-fade', '0');
      self.s = loadSettings();
      self.lastHtml = {};
      self.worldKey = '';
      self.menuTab = 'courses'; self.sel = null; self.renaming = null; self.armed = null; self.loginAsked = false;
      self.startBoot(true);
      if (self.s.sound && snd) { self.chimeUrl = snd; self.chimePending = true; }
      self.applySettings();
      self.renderMedia();
      self.requestMap(true);
      self.lua('if not TreadXLGPS then extensions.load("TreadXLGPS") end');
      self.pushPacenoteOptions();
      self.pushMarkDefaults();
      self.call('requestState');
      self.call('requestMedia');
      self.renderAll();
    }, RESTART_DARK);
  };
  P.bootCheck = function () {
    if (!this.booting) { clearInterval(this.bootTimer); return; }
    var age = Date.now() - this.bootT0, ready = this.mapState === 'roads' || this.mapState === 'terrain';
    var LOAD = this.bootLoadMs || BOOT_LOAD, READ = this.bootReadMs || BOOT_READ;
    var bar = this.el.boot.querySelector('.b-bar i'), txt = this.el.boot.querySelector('.b-txt');
    if (!this.bootFull) {
      // the app was opened in a map that was already loaded: just until the map is there
      bar.style.width = Math.max(0, Math.min(100, age / 5000 * 100)).toFixed(1) + '%';
      if ((ready && age > 1400) || age > 5000) { this.booting = false; clearInterval(this.bootTimer); this.el.boot.classList.remove('show'); if (ONYX) this.showHome(true); this.maybeLogin(); }
      return;
    }
    if (age < LOAD) {
      bar.style.width = Math.max(0, Math.min(100, age / LOAD * 100)).toFixed(1) + '%';
      txt.textContent = (this.bootLoadMs ? 'Restarting\u2026 ' : 'Loading map\u2026 ') + Math.max(1, Math.ceil((LOAD - age) / 1000)) + ' s';
      return;
    }
    if (!this.bootReady) {
      // loading done: the chime, and the screen stays a few seconds to be read
      this.bootReady = true;
      bar.style.width = '100%';
      this.el.boot.classList.add('ready');
      this.el.boot.querySelector('.b-info').innerHTML = 'BAJA75 NAVIGATION UNIT v' + esc(VERSION) + '<br><b>Leshii413 | Baja75 Series</b>' +
        (this.mapName || (this.hello && this.hello.level) ? '<br>' + esc(dispName(this.mapName || this.hello.level)) : '');
      if (this.chimePending) { this.chimePending = false; this.playStartup(this.chimeUrl); }
    }
    txt.textContent = ready ? 'Ready' : 'Waiting for the map\u2026';
    if ((ready && age >= LOAD + READ) || age > BOOT_MAX || (this.bootLoadMs && age >= LOAD + READ)) { // a restart doesn't wait for the map
      this.booting = false;
      if (ONYX) this.showHome(true);
      clearInterval(this.bootTimer);
      this.el.boot.classList.remove('show');
      this.maybeLogin();
    }
  };
  // the chime plays in the UI; if the page may not play audio yet, the game's own audio plays the same file
  P.playStartup = function (url) {
    if (this.isDash) return; // one chime: the HUD unit's
    var self = this, settled = false;
    var vol = 0.8 * Math.max(0, Math.min(1, Number(this.s.chimeVol) || 0));
    var viaGame = function () { if (settled) return; settled = true; self.call('playSound', luaStr('startup') + ', ' + luaNum(vol.toFixed(2))); };
    try {
      var a = new window.Audio(String(url || APP_DIR + 'sounds/startup.ogg'));
      a.volume = vol;
      var pr = a.play();
      if (pr && pr.then) pr.then(function () { settled = true; }, viaGame); else settled = true;
    } catch (_) { viaGame(); }
  };
  P.renderMapHint = function () {
    var h = this.el.hint;
    var txt = this.mapState === 'roads' || this.mapState === 'terrain' ? '' : 'Loading map' + (this.mapReason ? ' \u00b7 ' + this.mapReason : '\u2026');
    h.textContent = txt;
    h.classList.toggle('show', !!txt);
  };
  P.mapSize = function () { return [this.el.map.clientWidth || 0, this.el.map.clientHeight || 0]; };
  P.anchor = function () {
    var sz = this.mapSize();
    return [sz[0] / 2 + this.pan[0], sz[1] * (this.s.northUp ? 0.5 : 0.62) + this.pan[1]];
  };
  P.updatePanUi = function () {
    var panned = Math.abs(this.pan[0]) + Math.abs(this.pan[1]) > 4;
    this.el.center.classList.toggle('panned', panned);
    this.root.setAttribute('data-panned', panned ? '1' : '0');
    this.ov.xhair.setAttribute('visibility', panned ? 'visible' : 'hidden');
  };
  // v3.4: buttons hidden on the map (MENU > Display > On the map): a tap on the map shows them for a few seconds
  P.revealButtons = function () {
    if (!(this.s.cleanMap || !this.s.mapBtns || !this.s.actBtns) || !PLUS()) return;
    var self = this;
    this.root.setAttribute('data-reveal', '1');
    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(function () { self.root.setAttribute('data-reveal', '0'); }, 6000);
  };
  P.zoom = function (dir) {
    this.s.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.s.zoom * (dir > 0 ? 1.35 : 1 / 1.35)));
    this.save();
    this.renderScale();
  };
  P.effZoom = function () { return this.s.zoom * (this.s.autoZoom ? this.zoomFactor : 1); };
  // smooth the 10 Hz GPS fix: extrapolate along the heading, then ease toward it
  P.updateCamera = function (now, dt) {
    var h = this.hud;
    if (!h || h.x == null || h.y == null) return false;
    if (h !== this._hudObj) { this._hudObj = h; this._hudT = now; }
    var age = Math.min(0.3, Math.max(0, (now - this._hudT) / 1000));
    var hd = (Number(h.heading) || 0) * Math.PI / 180, sp = Number(h.speed) || 0;
    var tx = h.x + Math.sin(hd) * sp * age, ty = h.y + Math.cos(hd) * sp * age;
    var c = this.camState;
    if (!c || Math.hypot(tx - c.x, ty - c.y) > 150) {
      this.camState = c = { x: tx, y: ty, h: Number(h.heading) || 0 };
    } else {
      var a = Math.min(1, dt * 12);
      c.x += (tx - c.x) * a; c.y += (ty - c.y) * a;
      var dh = ((((Number(h.heading) || 0) - c.h) % 360) + 540) % 360 - 180;
      c.h = (c.h + dh * Math.min(1, dt * 8) + 360) % 360;
    }
    // auto zoom: zoom out as speed rises (eased)
    var target = 1 / (1 + Math.max(0, sp - 8) / 22);
    target = Math.max(0.4, Math.min(1, target));
    this.zoomFactor += (target - this.zoomFactor) * Math.min(1, dt * 1.2);
    return true;
  };

  // ---------------------------------------------------------------- events from Lua / the game
  // the game script sends the position 10 times a second; if this screen falls behind, older ones are skipped (only
  // the newest is drawn), and each drawn one is acknowledged so the game script can wait instead of piling them up
  P.queueHud = function (d) {
    this.hudPending = d;
    this.hudHas = true;
    if (this.hudRafId) return;
    var self = this, done = false;
    var flush = function () {
      if (done) return;
      done = true; self.hudRafId = 0; clearTimeout(self.hudTo);
      self.flushHud();
    };
    this.hudRafId = window.requestAnimationFrame ? window.requestAnimationFrame(flush) : 1;
    this.hudTo = setTimeout(flush, 120); // (no frames while the game window is in the background)
  };
  P.flushHud = function () {
    if (!this.hudHas || this.destroyed) return;
    var d = this.hudPending;
    this.hudPending = null; this.hudHas = false;
    this.hudNow = true;
    try { this.onEvent(EV + 'hud', d); } finally { this.hudNow = false; }
    if (!this.isDash && d && typeof d.seq === 'number') this.lua('if TreadXLGPS and TreadXLGPS.hudAck then TreadXLGPS.hudAck(' + d.seq + ') end');
  };
  P.onEvent = function (name, d) {
    if (this.destroyed) return;
    if (this.isDash && name === EV + 'cmd') return; // the vehicle's screen only shows: the keys act in the HUD unit
    switch (name) {
      case EV + 'basemap':
        if (!d) break;
        if (d.pending) {
          if (this.mapState !== 'roads') { this.mapReason = String(d.reason || ''); this.renderMapHint(); }
        } else {
          this.view.setCompactMap(d);
          this.baseData = d; // roads for the course map picture
          this.mapInfo = { level: d.level, nodes: d.nodes, roads: d.roads, tiles: this.view.info.tiles || 0 };
          if (this.view.info.segments > 0) { this.mapState = 'roads'; clearTimeout(this.mapTimer); }
          else if (this.view.info.tiles > 0) this.mapState = 'terrain'; // no roads yet - keeps asking every few seconds
          this.worldKey = '';
          this.renderMapHint();
        }
        if (this.sheet === 'menu') this.renderSheet();
        break;
      case EV + 'hello':
        if (this.yts) { this.yts.asked = false; this.yts.port = 0; } // the game's Lua restarted: ask for the video page again
        this.telOn = null; // ... and tell it again whether Tuner gauges are on screen
        if (d && d.boot) {
          // a map was just joined: power-on screen, and the chime once the 15 s of loading are over
          if (!this.booting) this.startBoot();
          this.bootFull = true;
          if (this.s.sound) { this.chimeUrl = d.startupSound; if (this.bootReady) this.playStartup(this.chimeUrl); else this.chimePending = true; }
        }
        if (!this.hello || (d && d.boot)) { this.call('setSound', this.s.sound ? 'true' : 'false'); this.pushPacenoteOptions(); this.pushMarkDefaults(); this.pushDriver(); }
        if (!this.isDash && (!this.hello || (d && d.boot) || (d && d.dash !== !!this.s.dash))) { this.call('setDash', this.s.dash ? 'true' : 'false'); this.dashLast = null; this.dashSync(); } // v3.2: the game script knows
        this.hello = d || { version: '?' };
        clearTimeout(this.helloTimer);
        this.access = (d && d.access) || null; // on a Baja75 server? unlocked with the password? (Common: courses used)
        var full = !!(this.access && (this.access.server || this.access.ed === 'full'));
        if (full !== FULL) { FULL = full; if (EDITION !== 'full') this.editionChanged(); }
        this.licenseChanged();
        this.accessChanged();
        this.maybeLogin();
        this.renderBanner();
        if (this.sheet === 'menu') this.renderSheet();
        break;
      case EV + 'pacenoteInfo':
        this.pnInfo = d || null;
        if (this.sheet) this.renderSheet();
        break;
      case EV + 'pacenotePreview':
        this.pnPreview = d || null;
        if (this.sheet === 'mark') this.renderSheet();
        break;
      case EV + 'snapshot': this.makeSnapshot(d); break;
      case EV + 'media':
        this.media = { music: arr(d && d.music), videos: arr(d && d.videos), paths: (d && d.paths) || {}, real: (d && d.real) || {} };
        this.renderMedia();
        break;
      case EV + 'videoServer': this.videoServerReady(d); break;
      case EV + 'videoHit': if (this.yts) this.yts.hits = (this.yts.hits || 0) + 1; break;
      case EV + 'tel': if (d && typeof d === 'object') { this.telx = d; this.telAt = Date.now(); } break;
      case EV + 'musicArt':
        if (d && typeof d.path === 'string') { this.arts = this.arts || {}; this.arts[d.path] = typeof d.art === 'string' && /^\/settings\/TreadXLGPS\/[^"'<>]+\.(jpe?g|png|webp|gif|bmp)$/i.test(d.art) ? d.art : ''; this.mbarKey = ''; this.lastHtml.mnow = ''; this.mediaTick(true); }
        break;
      case EV + 'clipboard': {
        var ct = String((d && d.text) || '').trim();
        if (!ct) { this.toast(d && d.ok === false ? 'This game version can\u2019t read the clipboard - use the keyboard button' : 'The clipboard is empty', 'warning'); break; }
        this.videoUrl = ct.slice(0, 500);
        if (this.m) this.m.url.value = this.videoUrl;
        if (parseYouTube(ct)) this.videoPlay(ct);
        else this.toast('Pasted - not a YouTube link: press WEB to open it in your browser', 'info');
        break;
      }
      case EV + 'runLog':
        this.runLog = d || {};
        this.runLog.entries = arr(this.runLog.entries);
        if (this.sheet === 'menu' && this.menuTab === 'times') this.renderSheet();
        break;
      case EV + 'courseInfo':
        if (d && d.name) { this.courseInfo[courseKey(d.name, d.source)] = d; if (this.sheet === 'menu') this.renderSheet(); }
        break;
      case EV + 'text': {
        if (!d || !d.kind) break;
        var txt = String(d.text == null ? '' : d.text);
        if (d.kind === 'markLabel') { this.s.markLabel = txt.slice(0, 32); this.save(); this.pushMarkDefaults(); }
        else if (d.kind === 'recName') this.recName = txt.slice(0, 48);
        else if (d.kind === 'driverName' || d.kind === 'raceNumber') { this.s[d.kind] = cleanDriver(txt, d.kind === 'driverName' ? 40 : 8); this.save(); this.pushDriver(); }
        else if (d.kind === 'videoPage') {
          if (isYouTubeAddress(txt)) { this.s.videoPage = ''; this.toast('That\u2019s a YouTube video link: it goes in the video screen. This box is only for the address of your own copy of yt.html', 'warning'); }
          else { this.s.videoPage = txt.trim().slice(0, 300); delete this.s.videoBlocked.own; }
          this.save(); if (this.sheet === 'menu') this.renderSheet();
        }
        else if (d.kind === 'unlockPw') { this.unlockText = txt.slice(0, 40); this.act('unlockGo'); break; }
        else if (d.kind === 'loginName') this.loginName = cleanDriver(txt, 40);
        else if (d.kind === 'loginNum') this.loginNum = cleanDriver(txt, 8);
        else if (d.kind === 'videoUrl') { this.videoUrl = txt.slice(0, 500); if (this.m) this.m.url.value = this.videoUrl; this.videoPlay(this.videoUrl); }
        else if (d.kind === 'renameText') {
          this.renameText = txt.slice(0, 48);
          if (this.renaming && this.renameText.trim()) this.act('renameSave');
        }
        if (this.sheet) this.renderSheet();
        break;
      }
      case EV + 'hud':
        // v3.3: the newest position only, once per frame (a slow screen never builds up a queue of old positions)
        if (!this.hudNow) { this.queueHud(d); break; }
        this.hud = d || null;
        if (this.passData && arr(this.passData.alerts).length) this.renderPass(); // a danger alert puts the pass card lower
        if (this.hud && !this.hudSeen) { this.hudSeen = true; if (!this.hello && this.helloTries) this.renderBanner(); }
        if (this.hud) {
          this.hud.next = arr(this.hud.next); this.hud.marks = arr(this.hud.marks); this.hud.vcpStates = arr(this.hud.vcpStates);
          if (ED() === 'chase') { // the game script does this too; here in case two editions got mixed
            this.hud.next = this.hud.next.filter(function (w) { return shownKind(w.kind); });
            this.hud.marks = this.hud.marks.filter(function (w) { return shownKind(w.kind); });
            if (this.hud.alert && /^(danger|hazard)Ahead$/.test(String(this.hud.alert.kind))) this.hud.alert = null;
            this.hud.pacenotes = null;
          }
          this.hud.others = arr(this.hud.others);
          if (this.hud.race) this.hud.race.splits = arr(this.hud.race.splits);
          if (this.hud.pacenotes) this.hud.pacenotes.next = arr(this.hud.pacenotes.next);
          if (this.hud.x != null) this.view.setBounds('veh', [this.hud.x - 1200, -this.hud.y - 1200, this.hud.x + 1200, -this.hud.y + 1200]);
        }
        this.renderHud();
        break;
      case EV + 'list': {
        var prevMap = this.mapName;
        this.routes = arr(d && d.routes); this.mapName = (d && d.map) || '';
        this.gpxFiles = arr(d && d.gpx);
        this.paths = (d && d.paths) || {};
        this.real = (d && d.real) || {};
        this.commonCourses = (d && d.common) || null; // the Common Edition: your courses used of 2
        if (prevMap && this.mapName && prevMap !== this.mapName) this.mapChanged();
        if (this.sheet === 'menu') this.renderSheet();
        break;
      }
      case EV + 'course':
        this.course = d && d.name ? d : null;
        if (this.course) {
          this.course.flat = arr(this.course.flat);
          this.course.wpts = arr(this.course.wpts).filter(function (w) { return shownKind(w.kind); });
          this.course.zones = arr(this.course.zones);
          this.course.turns = sharpTurns(this.course.flat);
          this.course.drawFlat = simplify(this.course.flat, 0.6);
          var f = this.course.flat, b = [Infinity, Infinity, -Infinity, -Infinity];
          for (var i = 0; i + 1 < f.length; i += 2) { b[0] = Math.min(b[0], f[i]); b[2] = Math.max(b[2], f[i]); b[1] = Math.min(b[1], -f[i + 1]); b[3] = Math.max(b[3], -f[i + 1]); }
          this.view.setBounds('course', f.length ? b : null);
        }
        this.wpts = { owner: this.course ? 'course' : (this.rec.active ? 'rec' : null), wpts: this.course ? this.course.wpts : this.wpts.wpts };
        this.worldKey = '';
        if (this.sheet) this.renderSheet();
        this.renderAll();
        break;
      case EV + 'wpts':
        this.wpts = { owner: d && d.owner, wpts: arr(d && d.wpts).filter(function (w) { return shownKind(w.kind); }) };
        if (this.course && d && d.owner === 'course') this.course.wpts = this.wpts.wpts;
        this.worldKey = '';
        if (this.sheet === 'menu') this.renderSheet();
        break;
      case EV + 'trail':
        if (!d) break;
        if (d.reset) this.trail = [];
        if (arr(d.flat).length) {
          this.trail = this.trail.concat(d.flat);
          var t = this.trail, tb = [Infinity, Infinity, -Infinity, -Infinity];
          for (var j = 0; j + 1 < t.length; j += 2) { tb[0] = Math.min(tb[0], t[j]); tb[2] = Math.max(tb[2], t[j]); tb[1] = Math.min(tb[1], -t[j + 1]); tb[3] = Math.max(tb[3], -t[j + 1]); }
          this.view.setBounds('trail', tb);
        }
        this.worldKey = '';
        break;
      case EV + 'rec':
        this.rec = { active: !!(d && d.active), name: d && d.name };
        if (this.sheet === 'menu') this.renderSheet();
        this.renderAll();
        break;
      case EV + 'chaseTargets':
        this.chaseTargets = arr(d && d.targets);
        this.chaseCurrent = d ? d.current : null;
        if (this.sheet === 'chase') this.renderSheet();
        this.el.chaseBtn.classList.toggle('on', this.chaseCurrent != null);
        break;
      case EV + 'icons':
        if (d && arr(d.icons).length) {
          var known = d.icons.filter(function (f) { return ICON_BY_FILE[f]; });
          var extra = d.icons.filter(function (f) { return !ICON_BY_FILE[f]; });
          var ordered = ICONS.map(function (i) { return i.file; }).filter(function (f) { return known.indexOf(f) >= 0; });
          this.icons = ordered.concat(extra).filter(shownIcon);
          if (this.sheet === 'mark') this.renderSheet();
        }
        break;
      case EV + 'cmd':
        if (!d) break;
        if (d.cmd === 'zoom') this.zoom(d.dir);
        else if (d.cmd === 'orientation') this.act('orient');
        else if (d.cmd === 'mapChanged') this.mapChanged();
        else if (d.cmd === 'button') this.hwButton(Number(d.n));
        else if (d.cmd === 'popup') { if (!this.isDash) this.togglePop(d.on); }
        else if (d.cmd === 'media') this.mediaKey(String(d.what || ''));
        break;
      case EV + 'toast': if (d && d.text) this.toast(d.text, d.level); break;
      case EV + 'locked': if (d && d.what) this.guard(d.what === 'wpts' ? 'wpts' : String(d.what)); break;
      case EV + 'notice': if (d && d.text) { this.notice = d; this.openSheet('notice'); } break;
      case EV + 'login': this.openLogin(d && d.what); break;
      case EV + 'gallery': this.galData = d || { shots: [] }; this.galBad = 0; this.renderGallery(); break;
      case EV + 'pass': // v3.3: race passing alerts (the PASS button, the incoming request card)
        this.passData = d || null;
        this.renderPass();
        break;
      case EV + 'dashState': // v3.2: the game script says whether the unit is on this car's screen
        this.dashScreen = !!(d && d.on && d.screen);
        this.root.setAttribute('data-dashscreen', this.dashScreen ? '1' : '0');
        if (!this.dashScreen && this.pop) this.togglePop(false);
        break;
    }
  };
  // the game-side script answers requestState() with 'hello'; if it doesn't, say so on the screen
  P.checkHello = function () {
    var self = this;
    if (this.destroyed || this.hello) return;
    this.helloTries++;
    this.renderBanner();
    this.lua('if not TreadXLGPS then extensions.load("TreadXLGPS") end if TreadXLGPS and TreadXLGPS.requestState then TreadXLGPS.requestState() end');
    this.helloTimer = setTimeout(function () { self.checkHello(); }, 5000);
  };
  // off the Baja75 BeamMP servers (Lua: TreadXLGPS LOCK) these need the password (until the game closes): recording, in the
  // full GPS and the Chase and Rally Editions; in the full GPS also MARK, the Chase Map, switching modes, split screen, the
  // Record / Waypoints / Share / Display tabs and the course buttons that write waypoints or share. The password screen only
  // shows when one of those is asked for. The Common Edition has no locks (and no recording).
  P.allowed = function (what) {
    var a = this.access;
    if (ONYX) return true; // the Onyx Edition has no locks (and nothing to unlock)
    if (a && (a.server || a.unlocked || a.password)) return true; // a Baja75 server, the password, a key's time or the admin hour
    if (what === 'pip') return false;                // picture-in-picture corners and music style: unlocked only
    if (COMMON || !a) return true;
    return EDITION === 'full' ? false : what !== 'record'; // the Chase, Rally and Track Editions lock recording only
  };
  // true = go ahead; false = the password screen (then: what to do once unlocked)
  P.guard = function (what, then) {
    if (this.allowed(what)) return true;
    this.unlockFor = { what: what, then: then || null };
    this.unlockText = '';
    this.openSheet('unlock');
    return false;
  };
  // joined / left a Baja75 server, unlocked or locked again
  P.accessChanged = function () {
    var f = this.unlockFor;
    var lg = this.login();
    if (this.sheet === 'login' && (!lg || lg.on)) { this.loginFor = null; this.openSheet(null); }
    if (this.sheet === 'menu' && TAB_LOCK[this.menuTab] && !this.allowed(TAB_LOCK[this.menuTab])) { this.menuTab = 'courses'; this.renderSheet(); }
    if ((this.sheet === 'mark' && !this.allowed('mark')) || (this.sheet === 'chase' && !this.allowed('chase'))) this.openSheet(null);
    if (this.sheet === 'unlock' && f && this.allowed(f.what)) { // unlocked: on to what was asked for
      this.unlockFor = null;
      this.openSheet(null);
      if (f.then) f.then.call(this);
    } else if (this.sheet === 'menu') this.renderSheet();
  };
  P.unlockHtml = function () {
    var f = this.unlockFor || {};
    var key = COMMON ? 'license key' : 'password or license key';
    return head(f.what ? 'Locked' : 'Unlock') + '<div class="txl-sheetbody"><div class="txl-unlock">' +
      (f.what ? '<div class="ul-t">' + esc(LOCK_NAMES[f.what] || 'This part of the unit') + ' is locked off the Baja75 servers</div>' : '<div class="ul-t">Unlock this unit</div>') +
      '<div class="ul-s">Enter your ' + key + '.</div>' +
      '<div class="txl-row ul-row"><input class="txl-input" type="password" data-in="unlockPw" data-enter="unlockGo" maxlength="40" placeholder="' + (COMMON ? 'License key' : 'Password or license key') + '" autocomplete="off" value="">' +
      kbd('unlockPw') + btn('unlockGo', 'UNLOCK', 'primary') + '</div>' +
      '<div class="txl-note">A personal-use unlocking license for your own BeamNG can be bought from <b>Baja75 on Patreon</b>. Or join a Baja75 server: everything is open there.</div>' +
      '</div></div>';
  };
  // v3.1.7: sign in (the full unit / Adventure, Chase, Rally and Track Editions): a username on every recording and run.
  // No password: it is only a name. On a BeamMP server with a real BeamMP name (not a Guest) the game script signs in by
  // itself; offline, as a Guest or after leaving a server, recording and racing ask for this screen first.
  P.login = function () { return (this.access && this.access.login) || null; };
  P.maybeLogin = function () {
    var l = this.login();
    if (!l || l.on || this.loginAsked || this.booting || this.restarting || !this.hello) return;
    if (this.sheet && this.sheet !== 'login') return; // not over something already open
    this.loginAsked = true; // once per start (the power button starts again)
    this.openLogin(null);
  };
  P.openLogin = function (what) {
    this.loginFor = { what: what || null };
    this.loginName = this.s.driverName || ''; this.loginNum = this.s.raceNumber || '';
    this.openSheet('login');
  };
  P.loginHtml = function () {
    var l = this.login() || {}, f = this.loginFor || {}, first = !this.s.driverName;
    var why = f.what === 'record' ? 'Sign in to record a course' : f.what === 'race' ? 'Sign in to race' : first ? 'Welcome to the Baja75 Navigation Unit' : 'Sign in';
    return head(first ? 'First time set up' : 'Sign in') + '<div class="txl-sheetbody"><div class="txl-unlock txl-login">' +
      '<div class="ul-t">' + esc(why) + '</div>' +
      '<div class="ul-s">Your username goes on every course you record and every timed run. It is only a name: no password.</div>' +
      '<div class="txl-row ul-row"><input class="txl-input" type="text" data-in="loginName" data-enter="loginGo" maxlength="40" placeholder="Username" autocomplete="off" value="' + esc(this.loginName || '') + '">' + kbd('loginName') + '</div>' +
      '<div class="txl-row ul-row"><input class="txl-input short" type="text" data-in="loginNum" data-enter="loginGo" maxlength="8" placeholder="Race #" autocomplete="off" value="' + esc(this.loginNum || '') + '">' + kbd('loginNum') + '<div class="t2 ul-opt">Race number (optional)</div></div>' +
      '<div class="txl-btnrow">' + btn('loginGo', 'SIGN IN', 'primary') + btn('loginLater', 'LATER') + '</div>' +
      '<div class="txl-note">' + (l.guest ? '<b>You joined this server as a Guest:</b> sign in with a username. ' : '') +
      'On a BeamMP server you are signed in with your BeamMP name. Offline, or after leaving a server, sign in here to record or race.</div>' +
      '</div></div>';
  };
  // a message from the game script (a key that isn't needed here, keys on another server, ...)
  P.noticeHtml = function () {
    var n = this.notice || {};
    return head('Notice') + '<div class="txl-sheetbody"><div class="txl-unlock">' +
      '<div class="ul-t">' + esc(n.text || '') + '</div>' +
      (n.shot ? '<div class="ul-s">Take a screenshot of this screen and send it to Baja75 with your request.</div>' : '') +
      (n.patreon ? '<div class="ul-s">Baja75 on Patreon</div>' : '') +
      '<div class="txl-btnrow">' + btn('noticeOk', 'OK', 'primary') + '</div></div></div>';
  };
  // what each lock is called on the password screen, and the menu tabs it covers
  var LOCK_NAMES = { record: 'Recording', mark: 'MARK', chase: 'The Chase Map', modes: 'Switching modes', split: 'Split screen', recordTab: 'The Record tab',
    wpts: 'Waypoints', share: 'Sharing out (Export GPX, server pack)', display: 'The Display tab', pacenotes: 'Writing pacenotes', pip: 'Picture-in-picture' };
  // the Share tab opens without the password (Import GPX works); Export GPX, the server pack and the map picture ask (v3)
  var TAB_LOCK = { record: 'recordTab', wpts: 'wpts', display: 'display' };
  P.renderBanner = function () {
    var txt = '';
    if (this.hello) {
      if (String(this.hello.version) !== VERSION) txt = 'Game script v' + this.hello.version + ' but screen v' + VERSION + ': more than one Baja75 Navigation Unit zip in your mods folder? Keep only the newest one and restart the game.';
      else if (this.hello.edition && this.hello.edition !== EDITION) txt = 'Two editions are installed (' + this.hello.edition + ' and ' + EDITION + '): keep only one Baja75 Navigation Unit zip in your mods folder and restart the game.';
    } else if (this.helloTries) {
      txt = this.hudSeen
        ? 'An older game script is running. Remove old Baja75 Navigation Unit / Tread XL zips from your mods folder (keep only v' + VERSION + ') and restart the game.'
        : 'The GPS game script isn\u2019t running, so nothing can load or save. Press ~ and look for red TreadXLGPS lines, and keep only one Baja75 Navigation Unit zip in your mods folder.';
    }
    this.el.banner.textContent = txt;
    this.el.banner.classList.toggle('show', !!txt);
  };
  P.mapChanged = function () {
    this.camState = null;
    this.view.bounds = {};
    this.view.ext = null;
    this.trail = [];
    this.requestMap(true);
    this.call('requestState'); // a map was joined after the app opened: the game script says so (power-on screen + chime)
  };

  // ---------------------------------------------------------------- actions
  P.findRoute = function (key) {
    for (var i = 0; i < this.routes.length; i++) if (courseKey(this.routes[i].name, this.routes[i].source) === key) return this.routes[i];
    return null;
  };
  P.act = function (a, el) {
    if (this.root.getAttribute('data-bsod') === '1') return; // the error screen: nothing works
    if (isCommon() && COMMON_OFF[a]) return; // not in the Common Edition (open on a Baja75 server)
    if (isFree() && FREE_OFF[a]) { this.nudge(); return; }
    if (ONYX && ONYX_OFF[a]) return; // not in the Onyx Edition
    var self = this, v = el && el.getAttribute ? el.getAttribute('data-v') : null;
    var sel = this.sel ? this.findRoute(this.sel) : null;
    var selArgs = sel ? luaStr(sel.name) + ', ' + luaStr(sel.source) : '';
    switch (a) {
      case 'zoomIn': this.zoom(1); break;
      case 'zoomOut': this.zoom(-1); break;
      case 'orient':
        this.s.northUp = !this.s.northUp; this.save();
        this.renderHud();
        if (this.sheet === 'menu') this.renderSheet();
        break;
      case 'center': this.pan = [0, 0]; this.updatePanUi(); break;
      case 'closeResult': this.resultClosed = this.resultKey; this.renderRace(this.hud || {}); this.renderAlert(this.hud || {}); break;
      case 'recToggle':
        if (this.rec.active) this.call('stopRecording');
        else if (this.guard('record')) this.call('startRecording', luaStr(''));
        break;
      case 'undoMark': { // while recording: take back the last waypoint marked
        var rw = this.wpts && this.wpts.owner === 'rec' ? this.wpts.wpts : [], lastId = 0;
        rw.forEach(function (w) { if (w.id > lastId) lastId = w.id; });
        if (!this.rec.active || !lastId) { this.toast('Nothing marked on this recording yet', 'info'); break; }
        this.call('deleteWaypoint', luaNum(lastId)); this.toast('Removed the last waypoint', 'info'); break;
      }
      case 'mark': if (this.guard('mark', function () { this.openSheet('mark'); })) this.openSheet('mark'); break;
      case 'chase': {
        var openChase = function () { this.openSheet('chase'); this.call('requestChaseTargets'); };
        if (this.guard('chase', openChase)) openChase.call(this);
        break;
      }
      case 'unlockGo': {
        var pw = this.unlockText || '';
        var box = this.el.sheets.unlock.querySelector('[data-in="unlockPw"]');
        if (box) { if (!pw) pw = box.value || ''; box.value = ''; }
        this.unlockText = '';
        if (pw) this.call('unlock', luaStr(pw)); // the game script checks it (only a digest of the password is in the mod)
        break;
      }
      case 'relock': this.call('lockAgain'); break;
      case 'keyOpen': this.unlockFor = { what: null }; this.unlockText = ''; this.openSheet('unlock'); break;
      case 'noticeOk': this.notice = null; this.openSheet(null); break;
      case 'popClose': this.togglePop(false); break;
      case 'galClose': this.galOpen(false); break;
      case 'galPage': this.galPage = Math.max(0, Number(v) || 0); this.renderGallery(); break;
      case 'galShow': this.galShow(Number(v)); break;
      case 'galPrev': this.galShow(this.galIdx - 1); break;
      case 'galNext': this.galShow(this.galIdx + 1); break;
      case 'galViewClose': this.galShow(-1); break;
      case 'passReq': this.call('passRequest'); break;
      case 'passOk': if (v) this.call('passAck', luaStr(v)); break;
      case 'passDismiss': if (v) this.call('passDismiss', luaStr(v)); break;
      case 'loginGo': {
        var lsh = this.el.sheets.login, lbox = lsh.querySelector('[data-in="loginName"]'), nbox = lsh.querySelector('[data-in="loginNum"]');
        var lname = cleanDriver(lbox ? lbox.value : this.loginName, 40).replace(/\s+$/, ''), lnum = cleanDriver(nbox ? nbox.value : this.loginNum, 8).replace(/\s+$/, '');
        if (!lname) { this.toast('Type a username to sign in', 'warning'); break; }
        this.s.driverName = lname; this.s.raceNumber = lnum; this.save();
        this.loginFor = null; this.openSheet(null);
        this.call('signIn', luaStr(lname) + ', ' + luaStr(lnum)); // the game script signs in, then does what was asked for
        break;
      }
      case 'loginLater': this.loginFor = null; this.call('loginCancel'); this.openSheet(null); break;
      case 'loginOpen': this.openLogin(null); break;
      case 'signOut': this.call('signOut'); break;
      case 'homeGo': this.homeGo(v); break;
      case 'nudgeClose': this.el.nudge.classList.remove('show'); break;
      case 'nudgeKey': this.el.nudge.classList.remove('show'); this.act('keyOpen'); break;
      case 'menu': this.openSheet('menu'); this.call('list'); break;
      case 'close': if (this.sheet === 'login') { this.loginFor = null; this.call('loginCancel'); } this.openSheet(null); break;
      case 'runOpen': this.runOpen = this.runOpen === v ? null : v; this.renderSheet(); break;
      case 'tab':
        if (TAB_LOCK[v] && !this.guard(TAB_LOCK[v], function () { this.openSheet('menu'); this.act('tab', { getAttribute: function () { return v; } }); })) break;
        this.menuTab = v; this.armed = null; this.renaming = null; if (v === 'share' || v === 'courses') this.call('list'); if (v === 'times') this.call('requestRunLog'); this.renderSheet(); break;
      case 'field': {
        var idx = Number(el.getAttribute('data-i')), set = this.fieldSet();
        var i = FIELD_ORDER.indexOf(set[idx]);
        for (var step = 1; step <= FIELD_ORDER.length; step++) { // next field not already on screen
          var next = FIELD_ORDER[(i + step) % FIELD_ORDER.length];
          if (set.indexOf(next) < 0) { set[idx] = next; break; }
        }
        this.save(); this.renderHud();
        break;
      }
      case 'pickIcon':
        this.s.markIcon = v; this.save(); this.pushMarkDefaults(); this.renderSheet();
        break;
      case 'markMode':
        this.s.markMode = v === 'rally' ? 'rally' : 'symbols'; this.save(); this.pushMarkDefaults();
        if (this.s.markMode === 'rally') { if (!this.pnInfo) this.call('requestPacenoteInfo'); this.call('pacenotePreview', luaPn(this.s.pnDraft)); }
        this.renderSheet();
        break;
      case 'pnSet': {
        var kv = String(v || '').split(':'), k1 = kv[0], v1 = kv.slice(1).join(':'), dr = this.s.pnDraft;
        if (k1 === 'd') dr.d = Number(v1) || 0;
        else if (k1 === 'c') { dr.c = v1; if (!dr.d) dr.d = 1; }
        else if (k1 === 'len') dr.len = dr.len === v1 ? '' : v1;
        else if (k1 === 'sh') dr.sh = dr.sh === v1 ? '' : v1;
        else if (k1 === 'ca') dr.ca = Number(v1) || 0;
        else if (k1 === 'm') {
          var mi = arr(dr.m).indexOf(v1);
          dr.m = arr(dr.m);
          if (mi >= 0) dr.m.splice(mi, 1); else if (dr.m.length < 3) dr.m.push(v1); else this.toast('Up to 3 extras per pacenote', 'info');
        }
        this.save(); this.pushMarkDefaults();
        this.call('pacenotePreview', luaPn(dr));
        this.renderSheet();
        break;
      }
      case 'pnListen': this.call('previewPacenote', luaPn(this.s.pnDraft)); break;
      case 'autoPn': if (!this.guard('pacenotes', function () { this.openSheet('menu'); })) break; if (sel) { this.call('generatePacenotes', selArgs); this.call('courseInfo', selArgs); } break;
      case 'clearAutoPn': {
        if (!this.guard('pacenotes', function () { this.openSheet('menu'); })) break;
        if (!sel) break;
        var ck = 'clearAutoPn:' + this.sel;
        if (this.armed !== ck) { this.armed = ck; this.renderSheet(); setTimeout(function () { if (self.armed === ck) { self.armed = null; self.renderSheet(); } }, 3000); break; }
        this.armed = null; this.call('clearAutoPacenotes', selArgs); this.call('courseInfo', selArgs);
        break;
      }
      case 'markHere':
      case 'markXhair': {
        var opts = this.s.markMode === 'rally' ? 'icon=' + luaStr(PN_ICON) + ', pn=' + luaPn(this.s.pnDraft)
          : 'icon=' + luaStr(this.s.markIcon) + ', label=' + luaStr(this.s.markLabel) + ', limitMph=' + luaNum(this.s.markLimit);
        if (a === 'markXhair' && this.view.cam) {
          var sz = this.mapSize(), w = this.view.toWorld(sz[0] / 2, sz[1] / 2);
          opts += ', x=' + luaNum(w[0].toFixed(2)) + ', y=' + luaNum(w[1].toFixed(2));
        }
        this.call('markWaypoint', '{' + opts + '}');
        if (this.s.markMode !== 'rally') this.s.markLabel = '';
        this.save(); this.pushMarkDefaults();
        this.openSheet(null);
        break;
      }
      case 'chaseSet': this.call('setChaseTarget', luaNum(v)); break;
      case 'chaseOff': this.call('setChaseTarget', '-1'); break;
      case 'chaseRefresh': this.call('requestChaseTargets'); break;
      case 'chaseInterval':
        this.s.chaseInterval = Number(v) || 0; this.save();
        this.call('setChaseInterval', luaNum(this.s.chaseInterval)); this.renderSheet();
        break;
      // courses
      case 'selCourse': {
        this.sel = this.sel === v ? null : v; this.renaming = null; this.armed = null;
        var picked = this.sel ? this.findRoute(this.sel) : null;
        if (picked) this.call('courseInfo', luaStr(picked.name) + ', ' + luaStr(picked.source));
        this.renderSheet();
        break;
      }
      case 'raceRoute': if (sel) { this.call('raceRoute', selArgs); this.openSheet(null); } break;
      case 'editNotes': if (sel) this.call('editNotes', selArgs); break;
      case 'raceGo': {
        var rr = this.hud && this.hud.race;
        if (!rr) {
          // RACE on the main screen: this course in race mode
          // START with a course loaded: timing starts right away on the line, otherwise it says where the start is
          if (this.course) this.call('raceRoute', luaStr(this.course.name) + ', ' + luaStr(this.course.source) + ', true');
          break;
        }
        if ((rr.state === 'staging' || rr.state === 'finished') && rr.ready) { this.armed = null; this.call('raceStart'); break; }
        if (rr.state === 'staging' || rr.state === 'finished') {
          // moving the car takes two taps
          if (this.armed !== 'raceTp') {
            this.armed = 'raceTp'; this.renderRace(this.hud);
            setTimeout(function () { if (self.armed === 'raceTp') { self.armed = null; self.renderRace(self.hud || {}); } }, 3000);
            break;
          }
          this.armed = null; this.call('raceToStart');
          break;
        }
        // ending a race takes two taps
        if (this.armed !== 'raceEnd') {
          this.armed = 'raceEnd'; this.renderRace(this.hud);
          setTimeout(function () { if (self.armed === 'raceEnd') { self.armed = null; self.renderRace(self.hud || {}); } }, 3000);
          break;
        }
        this.armed = null; this.call('raceEnd');
        break;
      }
      case 'load': if (sel) { this.call('loadCourse', selArgs); this.openSheet(null); } break;
      case 'unload': this.call('unloadCourse'); break;
      case 'resetRun': this.call('resetRun'); break;
      case 'renameStart': if (sel) { this.renaming = this.sel; this.renameText = dispName(sel.name); this.renderSheet(); var inp = this.el.sheets.menu.querySelector('[data-in="renameText"]'); if (inp) { inp.focus(); inp.select(); } } break;
      case 'renameCancel': this.renaming = null; this.renderSheet(); break;
      case 'renameSave':
        if (sel) { this.call('renameCourse', selArgs + ', ' + luaStr(this.renameText)); this.renaming = null; this.sel = courseKey(this.renameText.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, ''), 'mine'); }
        break;
      case 'copyCourse': if (sel) this.call('copyCourse', selArgs); break;
      case 'exportGpx': if (!this.guard('share', function () { this.openSheet('menu'); })) break; if (sel) this.call('exportGpx', selArgs); break;
      case 'serverPack': if (!this.guard('share', function () { this.openSheet('menu'); })) break; if (sel) this.call('addToServerPack', selArgs); break;
      case 'delCourse': {
        if (!sel) break;
        var key = 'delCourse:' + this.sel;
        if (this.armed !== key) { this.armed = key; this.renderSheet(); setTimeout(function () { if (self.armed === key) { self.armed = null; self.renderSheet(); } }, 3000); break; }
        this.armed = null; this.call('deleteCourse', selArgs); this.sel = null;
        break;
      }
      case 'delWpt': {
        var wkey = 'delWpt:' + v;
        if (this.armed !== wkey) { this.armed = wkey; this.renderSheet(); setTimeout(function () { if (self.armed === wkey) { self.armed = null; self.renderSheet(); } }, 3000); break; }
        this.armed = null; this.call('deleteWaypoint', luaNum(v));
        break;
      }
      case 'importGpx': this.call('importGpx', luaStr(v)); break;
      case 'openFolder': if (v === 'pack' && !this.guard('share', function () { this.openSheet('menu'); })) break; this.call('openFolder', luaStr(v)); break;
      // the five buttons under the screen, and the media screens
      case 'hw': this.hwButton(Number(v)); break;
      case 'power': this.restartSystem(); break;
      case 'vidFull': this.setVideoFull(!this.vfull); break;
      case 'pipMap': if (this.pipDragAt && Date.now() - this.pipDragAt < 400) break; this.s.display = 'gps'; this.save(); this.applySettings(); this.renderMedia(); this.renderAll(); break; // the map, full
      case 'mediaClose': this.mbarBig = false; this.vfull = false; this.s.split = false; this.s.display = 'gps'; this.save(); this.applySettings(); this.renderMedia(); this.renderAll(); break;
      case 'mediaSplit': {
        if (!this.guard('split')) break;
        if (!capsOf(this.s.mode).split) { this.toast('Split screen is for Adventure and Track mode (Chase and Rally have the music bar)', 'info'); break; }
        var pk0 = this.panelKind(); this.s.split = !this.s.split; if (pk0) { this.s.display = pk0; this.s.lastMedia = pk0; } this.save(); this.applySettings(); this.renderMedia(); this.renderAll(); break;
      }
      case 'mediaSwap': { var scr = this.screens(), nk = scr[(scr.indexOf(this.panelKind()) + 1) % scr.length]; if (nk) { this.s.display = nk; this.s.lastMedia = nk; } this.save(); this.applySettings(); this.renderMedia(); break; }
      case 'mbarOpen': if (this.barMode) { this.mbarBig = true; this.applySettings(); this.renderMedia(); this.renderAll(); break; } this.s.display = 'music'; this.s.lastMedia = 'music'; this.save(); this.applySettings(); this.renderMedia(); this.renderAll(); break;
      case 'mediaRescan': this.call('requestMedia'); this.toast('Looking for new files', 'info'); break;
      case 'mediaMute': this.mediaKey('mute'); break;
      case 'vidPaste': this.call('readClipboard'); break;
      case 'vidGo': this.videoPlay(this.m ? this.m.url.value : this.videoUrl); break;
      case 'vidPlay': this.videoToggle(); break;
      case 'vidBack': this.videoSeekBy(-10); break;
      case 'vidFwd': this.videoSeekBy(10); break;
      case 'vidBrowser': {
        var link = String((this.vid && this.vid.url) || (this.m ? this.m.url.value : '') || '').trim();
        if (!/^https?:\/\//i.test(link)) { var yy = parseYouTube(link); link = yy && yy.id ? 'https://www.youtube.com/watch?v=' + yy.id : ''; }
        if (!link) { this.toast('Paste a link first', 'warning'); break; }
        this.call('openLink', luaStr(link));
        break;
      }
      case 'vidLocal': this.videoFile(Number(v)); break;
      case 'vidRecent': { var rr = arr(this.s.recentLinks)[Number(v)]; if (rr && rr.url) { if (this.m) this.m.url.value = rr.url; this.videoPlay(rr.url); } break; }
      case 'musPlay': this.musicPlay(Number(v)); break;
      case 'musToggle': this.musicToggle(); break;
      case 'musNext': this.musicNext(1); break;
      case 'musPrev': this.musicPrev(); break;
      case 'musShuffle': this.s.musicShuffle = !this.s.musicShuffle; this.save(); this.renderMusicList(); break;
      case 'musRepeat': this.s.musicRepeat = this.s.musicRepeat === 'all' ? 'one' : this.s.musicRepeat === 'one' ? 'off' : 'all'; this.save(); this.renderMusicList(); break;
      case 'refreshFiles': this.call('list'); break;
      case 'reloadMap': this.requestMap(true); break;
      case 'recStart': if (!this.guard('record')) break; this.call('startRecording', luaStr(this.recName || '')); this.recName = ''; break;
      case 'recStop': this.call('stopRecording'); break;
      case 'recDiscard': this.call('stopRecording', 'true'); break;
      case 'set': {
        var k = el.getAttribute('data-k');
        if (isFree() && k !== 'themeNext' && k !== 'dash' && k !== 'passBtn') { this.nudge(); break; } // the Free Edition: settings can be looked at, not changed (volume, the key box, the theme and the vehicle's screen can)
        if (k === 'units') this.s.units = v;
        else if (k === 'northUp') this.s.northUp = v === '1';
        else if (k === 'bezel') this.s.bezel = v === '1';
        else if (k === 'dash') { this.s.dash = v === '1'; this.pop = false; this.call('setDash', this.s.dash ? 'true' : 'false'); }
        else if (k === 'themeNext') { this.s.themeNext = themeOf(v).id === this.theme().id ? '' : themeOf(v).id; if (this.s.themeNext) this.toast(themeOf(v).name + ': press the power button to apply', 'info'); }
        else if (k === 'deck') this.s.deck = v === '1';
        else if (k === 'sharpTurns') this.s.sharpTurns = v === '1';
        else if (k === 'autoZoom') this.s.autoZoom = v === '1';
        else if (k === 'courseColor') this.s.courseColor = v;
        else if (k === 'showOthers') this.s.showOthers = v === '1';
        else if (k === 'othersNames') this.s.othersNames = v === '1';
        else if (k === 'darkMode') this.s.darkMode = v;
        else if (k === 'clockSource') this.s.clockSource = v;
        else if (k === 'chipVcp') this.s.chipVcp = v === '1';
        else if (k === 'chipPit') this.s.chipPit = v === '1';
        else if (k === 'alertsOnGps') this.s.alertsOnGps = v === '1';
        else if (k === 'alertsMode') this.s.alertsMode = v;
        else if (k === 'alertsFlash') this.s.alertsFlash = v === '1';
        else if (k === 'passBtn') { this.s.passBtn = v === '1'; this.renderPass(); }
        else if (k === 'cleanMap' || k === 'mapBtns' || k === 'actBtns' || k === 'showFields' || k === 'showSpeed' || k === 'showScale') { if (!PLUS()) return; this.s[k] = v === '1'; }
        else if (k === 'chimeVol') this.s.chimeVol = Math.max(0, Math.min(1, Number(v) || 0));
        else if (k === 'sound') { this.s.sound = v === '1'; this.call('setSound', this.s.sound ? 'true' : 'false'); }
        else if (k === 'pnCalls' || k === 'pnLead' || k === 'pnVoice') { this.s[k] = v; if (k === 'pnVoice' && this.pnInfo) this.pnInfo.voice = v; this.pushPacenoteOptions(); }
        else if (k === 'pnNative') { this.s.pnNative = v === '1'; this.pushPacenoteOptions(); }
        else if (k === 'pnBar') this.s.pnBar = v === '1';
        else if (k === 'pnPop') this.s.pnPop = v === 'next' || v === 'off' ? v : 'called';
        else if (k === 'offCourseM') { this.s.offCourseM = Number(v) || 15; this.pushPacenoteOptions(); }
        else if (k === 'snapStyle') { if (!this.guard('share', function () { this.openSheet('menu'); })) return; this.s.snapStyle = v === 'satellite' ? 'satellite' : 'map'; }
        else if (k === 'mode') { if (this.guard('modes')) this.setMode(v); return; }
        else if (k === 'split') {
          var pk1 = this.panelKind(); this.s.split = v === '1'; if (pk1) this.s.display = pk1;
          if (this.s.split && !capsOf(this.s.mode).split) this.toast(PLUS() ? modeOf(this.s.mode).name + ' MODE: split screen with the music player' : 'Split screen works in Adventure and Track mode', 'info');
        }
        else if (k === 'vidPip' || k === 'musStyle' || k === 'musPip' || k === 'mbarPos') {
          if (!this.guard('pip', function () { this.openSheet('menu'); })) return;
          if (k === 'mbarPos') this.s.mbarPos = /^(bottom|top|left|right)$/.test(v) ? v : 'bottom';
          else this.s[k] = k === 'musStyle' ? (v === 'pip' ? 'pip' : 'split') : (/^(tl|tr|bl|br)$/.test(v) ? v : 'br');
          this.mbarBig = false;
        }
        else if (k === 'videoScreen') this.s.videoScreen = v === '1';
        else if (k === 'musicScreen') this.s.musicScreen = v === '1';
        else if (k === 'gaugesScreen') this.s.gaugesScreen = v === '1';
        else if (k === 'musicBar') this.s.musicBar = v === '1';
        else if (k === 'musicWithCalls') this.s.musicWithCalls = v === '1';
        else if (k === 'videoWeb') this.s.videoWeb = v === '1';
        else if (k === 'damageLog') { this.s.damageLog = v === '1'; this.pushPacenoteOptions(); }
        this.save(); this.applySettings(); this.worldKey = ''; this.renderAll(); this.renderSheet();
        break;
      }
      case 'videoUnblock': this.s.videoBlocked = {}; this.save(); this.toast('The video pages will be tried again', 'info'); this.renderSheet(); break;
      case 'siteCheck': this.siteCheck(); break;
      case 'exportRunLog': if (!this.hello) { this.toast('The game-side script isn\u2019t answering - see the red banner', 'error'); break; } this.call('exportRunLog'); break;
      case 'resetTrip': this.call('resetTrip'); this.toast('Trip and max speed reset', 'info'); break;
      case 'kbd': {
        var box = el && el.parentNode ? el.parentNode.querySelector('[data-in="' + v + '"]') : null;
        var cur = v === 'unlockPw' ? '' : box ? box.value : v === 'markLabel' ? this.s.markLabel : v === 'recName' ? this.recName : v === 'videoUrl' ? this.videoUrl : v === 'videoPage' ? this.s.videoPage : v === 'driverName' ? this.s.driverName : v === 'raceNumber' ? this.s.raceNumber : v === 'loginName' ? this.loginName : v === 'loginNum' ? this.loginNum : this.renameText;
        var title = v === 'unlockPw' ? 'Password' : v === 'markLabel' ? 'Waypoint name' : v === 'recName' ? 'New course name' : v === 'videoUrl' ? 'YouTube link' : v === 'videoPage' ? 'Your video page address' : v === 'driverName' ? 'Driver name' : v === 'raceNumber' ? 'Race number' : v === 'loginName' ? 'Username' : v === 'loginNum' ? 'Race number' : 'Rename course';
        if (!this.hello) { this.toast('The game-side script isn\u2019t answering - see the red banner', 'error'); break; }
        this.releaseInput();
        this.call('promptText', luaStr(v) + ', ' + luaStr(title) + ', ' + luaStr(cur || ''));
        this.toast('Type in the game window, then press Enter', 'info');
        break;
      }
    }
  };
  P.onInput = function (t, committed) {
    var k = t.getAttribute && t.getAttribute('data-in');
    if (!k) return;
    if (k === 'markLabel') { this.s.markLabel = String(t.value || '').slice(0, 32); if (committed) { this.save(); this.pushMarkDefaults(); } }
    else if (k === 'markLimit') { var n = Number(t.value); if (n >= 5 && n <= 200) { this.s.markLimit = this.s.units === 'metric' ? Math.round(n / 1.609344) : n; if (committed) { this.save(); this.pushMarkDefaults(); } } }
    else if (k === 'recName') this.recName = String(t.value || '').slice(0, 48);
    else if (k === 'driverName' || k === 'raceNumber') { this.s[k] = cleanDriver(t.value, k === 'driverName' ? 40 : 8); if (committed) { this.save(); this.pushDriver(); } }
    else if (k === 'renameText') this.renameText = String(t.value || '').slice(0, 48);
    else if (k === 'videoUrl') this.videoUrl = String(t.value || '').slice(0, 500);
    else if (k === 'unlockPw') this.unlockText = String(t.value || '').slice(0, 40);
    else if (k === 'loginName') this.loginName = String(t.value || '').slice(0, 40);
    else if (k === 'loginNum') this.loginNum = String(t.value || '').slice(0, 8);
    else if (k === 'videoPage') {
      var vp = String(t.value || '').trim().slice(0, 300);
      if (committed && isYouTubeAddress(vp)) { // a video link: play it, and keep this box for page addresses
        t.value = ''; this.s.videoPage = ''; this.save();
        this.toast('That\u2019s a YouTube video link: it goes in the video screen. This box is only for the address of your own copy of yt.html', 'warning');
        return;
      }
      this.s.videoPage = vp;
      if (committed) { delete this.s.videoBlocked.own; this.save(); if (vp && !pageAddress(vp)) this.toast('That isn\u2019t a web page address (https://\u2026/yt.html)', 'warning'); }
    }
    else if (k === 'mediaVol') { this.setVolume(Number(t.value)); if (committed) this.save(); }
    else if (isFree() && (k === 'mapOpacity' || k === 'videoPage')) { if (committed) { this.nudge(); this.renderSheet(); } return; } // view-only
    else if (k === 'vidSeek') {
      if (!committed) this.seeking = 'vid';
      else { this.seeking = null; var vs = this.videoState(); if (vs && vs.dur) this.videoSeekTo(Number(t.value) / 1000 * vs.dur); }
    }
    else if (k === 'musSeek') {
      if (!committed) this.seeking = 'mus';
      else { this.seeking = null; var au = this.audio; if (au && isFinite(au.duration) && au.duration > 0) { try { au.currentTime = Number(t.value) / 1000 * au.duration; } catch (_) { } } }
    }
    else if (k === 'mapOpacity') { this.s.mapOpacity = Math.max(0.3, Math.min(1, Number(t.value) || 1)); this.applyOpacity(); if (committed) this.save(); }
  };
  // the Mark waypoint key drops the last symbol, or the last pacenote built in MARK > Rally
  // the driver name / race number written into the run log for scoring (v3.1.5)
  P.pushDriver = function () { this.call('setDriver', luaStr(this.s.driverName || '') + ', ' + luaStr(this.s.raceNumber || '')); };
  P.pushMarkDefaults = function () {
    var rally = this.s.markMode === 'rally';
    this.call('setMarkDefaults', '{icon=' + luaStr(rally ? PN_ICON : this.s.markIcon) + ', label=' + luaStr(rally ? '' : this.s.markLabel) + ', limitMph=' + luaNum(this.s.markLimit) +
      (rally ? ', pn=' + luaPn(this.s.pnDraft) : '') + '}');
  };
  // dark mode dims the terrain image over a dark background (one opacity, no image filters needed)
  P.applyOpacity = function () { this.view.gTerrain.style.opacity = String(this.s.mapOpacity * (this.dark ? 0.32 : 1)); };
  P.applyTheme = function () {
    var dark = this.s.darkMode === 'on';
    if (this.s.darkMode === 'auto') {
      var tod = this.hud && typeof this.hud.tod === 'number' ? this.hud.tod : null;
      var hr = tod != null ? tod / 3600 : new Date().getHours() + new Date().getMinutes() / 60;
      dark = hr >= 19 || hr < 6.5;
    }
    if (dark === this.dark && this.root.getAttribute('data-dark') === (dark ? '1' : '0')) return;
    this.dark = dark;
    this.root.setAttribute('data-dark', dark ? '1' : '0');
    this.applyOpacity();
  };
  P.applySettings = function () {
    var r = this.root;
    var md = modeOf(this.s.mode);
    r.setAttribute('data-mode', md.id);
    r.setAttribute('data-edition', ED());
    r.setAttribute('data-dash', this.s.dash && !this.isDash ? '1' : '0');
    r.setAttribute('data-ondash', this.isDash ? '1' : '0');
    if (!this.s.dash && this.pop) { this.pop = false; r.setAttribute('data-pop', '0'); }
    r.setAttribute('data-full', FULL ? '1' : '0');
    this.renderHw();
    var th = this.theme(); // v3.1.9: the theme's colour replaces the mode's (the default Baja75 theme keeps the mode colours)
    r.setAttribute('data-theme', th.id);
    r.style.setProperty('--txl-accent', th.accent || md.color);
    var logo = ONYX ? 'onyx/logo.svg' : th.logo ? 'themes/' + th.id + '/logo.png' : 'logo.png';
    if (this.logoSrc !== logo) { this.logoSrc = logo; var li = this.root.querySelectorAll('.txl-logo, .txl-boot .b-logo img'); for (var i = 0; i < li.length; i++) li[i].src = APP_DIR + logo; }
    if (this.el.brandTag) this.el.brandTag.textContent = md.name;
    var pk = this.panelKind();
    // v3.4: music as a bar over the map instead of the card (tap it: the full player until DISPLAY or the map)
    var pcb = this.pipCfg(), barMode = PLUS() && pk === 'music' && !this.splitOn() && pcb.ms === 'pip' && !this.mbarBig;
    this.barMode = barMode;
    r.setAttribute('data-mbmode', barMode ? (pcb.open ? this.s.mbarPos : 'bottom') : 'none');
    if (barMode) pk = null;
    var big = PLUS() && this.mbarBig && this.panelKind() === 'music' && !this.splitOn();
    var cl = PLUS() && this.s.cleanMap;
    r.setAttribute('data-hidebtns', PLUS() && (cl || !this.s.mapBtns) ? '1' : '0');
    r.setAttribute('data-hideact', PLUS() && (cl || !this.s.actBtns) ? '1' : '0');
    r.setAttribute('data-hidefields', PLUS() && (cl || !this.s.showFields) ? '1' : '0');
    r.setAttribute('data-hidespeed', PLUS() && !cl && !this.s.showSpeed ? '1' : '0');
    r.setAttribute('data-hidescale', PLUS() && (cl || !this.s.showScale) ? '1' : '0');
    r.setAttribute('data-clean', cl ? '1' : '0');
    r.setAttribute('data-panel', pk || 'none');
    r.setAttribute('data-split', pk && this.splitOn() ? '1' : '0');
    if (pk !== 'video') this.vfull = false; // full screen belongs to the video screen
    var pc = this.pipCfg(), sp = pk && this.splitOn();
    r.setAttribute('data-vpip', pk === 'video' && !sp ? pc.v : 'none'); // (shown while a video plays: data-vplay)
    r.setAttribute('data-mpip', pk === 'music' && !sp && pc.ms === 'pip' && !big ? pc.m : 'none');
    r.setAttribute('data-vfull', this.vfull ? '1' : '0');
    this.renderMusicBar();
    r.setAttribute('data-bezel', this.s.bezel ? '1' : '0');
    r.setAttribute('data-deck', this.s.deck && !isFree() ? '1' : '0');
    r.style.setProperty('--txl-course', this.s.courseColor);
    this.applyTheme();
    this.applyOpacity();
    this.resize();
  };
  P.resize = function () {
    var w = this.root.clientWidth || 640;
    var fs = Math.max(5.5, Math.min(24, w / 64));
    this.root.style.fontSize = fs.toFixed(2) + 'px';
    this.root.setAttribute('data-compact', w < 470 ? '1' : '0');
  };

  // ---------------------------------------------------------------- toast
  P.toast = function (text, level) {
    var t = this.el.toast;
    t.textContent = text;
    t.className = 'txl-toast show ' + (level || 'info');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { t.className = 'txl-toast'; }, 3200);
  };

  // ---------------------------------------------------------------- data fields
  var FIELDS = {
    speed: { k: 'SPEED', f: function (a) { var s = fmtSpeed(a.h.speed, a.u); return [s.v, s.u]; } },
    raceMile: { k: function (u) { return u === 'metric' ? 'RACE KM' : 'RACE MILE'; }, f: function (a) { var c = a.h.course; return c && c.s != null ? [fmtRM(c.s, a.u), a.u === 'metric' ? 'km' : 'mi'] : null; } },
    toNext: { k: 'TO NEXT', f: function (a) { var n = a.h.next && a.h.next[0]; if (!n) return null; var d = fmtDist(n.ahead, a.u); return [d.v, d.u]; } },
    toFinish: { k: 'TO FINISH', f: function (a) { var c = a.h.course; if (!c || c.toFinish == null) return null; var d = fmtDist(c.toFinish, a.u); return [d.v, d.u]; } },
    nextVcp: { k: 'TO NEXT VCP', f: function (a) { var n = a.h.nextVcp; if (!n) return null; var d = fmtDist(n.ahead, a.u); return [d.v, d.u]; } },
    nextPit: { k: 'TO PIT', f: function (a) { var n = a.h.nextPit; if (!n) return null; var d = fmtDist(n.ahead, a.u); return [d.v, d.u]; } },
    raceTime: { k: 'RACE TIME', f: function (a) { var r = a.h.race; if (!r) return null; if (r.state === 'running') return [fmtRace(r.t), '']; if (r.result) return [fmtRace(r.result.t), 'LAST']; return null; } },
    vcps: { k: 'VCPS', f: function (a) { var v = a.h.vcps; return v && v.total ? [v.cleared + '/' + v.total, v.missed ? v.missed + ' MISSED' : ''] : null; } },
    heading: { k: 'HEADING', f: function (a) { return a.h.heading == null ? null : [a.h.heading + '\u00b0', compass(a.h.heading)]; } },
    elevation: { k: 'ELEVATION', f: function (a) { if (a.h.z == null) return null; return a.u === 'metric' ? [String(Math.round(a.h.z)), 'm'] : [String(Math.round(a.h.z / M_PER_FT)), 'ft']; } },
    trip: { k: 'TRIP', f: function (a) { var d = fmtDist(a.h.trip || 0, a.u); return [d.v, d.u]; } },
    maxSpeed: { k: 'MAX SPEED', f: function (a) { var s = fmtSpeed(a.h.maxSpeed || 0, a.u); return [s.v, s.u]; } },
    offCourse: { k: 'OFF COURSE', f: function (a) { var c = a.h.course; if (!c || c.off == null) return null; var d = fmtDist(c.off, a.u); return [d.v, d.u]; } },
    chaseDist: { k: 'TO RACE VEH', f: function (a) { var c = a.h.chase; if (!c || c.dist == null) return null; var d = fmtDist(c.dist, a.u); return [d.v, d.u]; } },
    chaseGap: { k: 'RACE VEH GAP', f: function (a) { var c = a.h.chase; if (!c || c.gap == null) return null; var d = fmtDist(c.gap, a.u); return [(c.gap > 0 ? '+' : '') + d.v, d.u]; } },
    chaseSpeed: { k: 'RACE VEH SPEED', f: function (a) { var c = a.h.chase; if (!c || c.speed == null) return null; var s = fmtSpeed(c.speed, a.u); return [s.v, s.u]; } },
    time: { k: 'TIME', f: function (a) { var t = clockText(a.tod).split(' '); return [t[0], t[1]]; } },
    // Tuner mode: the vehicle's own gauges (BeamNG electrics stream)
    rpm: { k: 'RPM', f: function (a) { var e = a.e; return e && isFinite(e.rpm) ? [String(Math.round(e.rpm / 10) * 10), 'rpm'] : null; } },
    gear: { k: 'GEAR', f: function (a) { var e = a.e; if (!e) return null; var g = e.gear != null ? e.gear : e.gear_M != null ? e.gear_M : e.gear_A; if (g == null) return null; if (typeof g === 'number') g = g === 0 ? 'N' : g < 0 ? 'R' : String(g); return [String(g), '']; } },
    throttle: { k: 'THROTTLE', f: function (a) { var e = a.e; return e && isFinite(e.throttle) ? [String(Math.round(e.throttle * 100)), '%'] : null; } },
    waterTemp: { k: 'WATER TEMP', f: function (a) { var e = a.e; return e && isFinite(e.watertemp) ? tempOf(e.watertemp, a.u) : null; } },
    oilTemp: { k: 'OIL TEMP', f: function (a) { var e = a.e; return e && isFinite(e.oiltemp) ? tempOf(e.oiltemp, a.u) : null; } },
    fuel: { k: 'FUEL', f: function (a) { var e = a.e; return e && isFinite(e.fuel) ? [String(Math.round(e.fuel * 100)), '%'] : null; } },
    boost: { k: 'BOOST', f: function (a) { var e = a.e; if (!e || !isFinite(e.turboBoost)) return null; return a.u === 'metric' ? [(e.turboBoost * 0.0689476).toFixed(2), 'bar'] : [e.turboBoost.toFixed(1), 'psi']; } },
    // electric / hybrid: charge left; fuel vehicles (the game has no 12 V battery): CHG while the engine charges it, else OFF
    battery: { k: 'BATTERY', f: function (a) {
      var t = a.t, e = a.e;
      if (t && isFinite(t.battery)) return [String(Math.round(t.battery * 100)), '%'];
      var run = t && isFinite(t.running) ? t.running : e && isFinite(e.engineRunning) ? e.engineRunning : null;
      return run == null ? null : run > 0.5 ? ['CHG', ''] : ['OFF', ''];
    } }
  };
  var TEL_FIELDS = { rpm: 1, gear: 1, throttle: 1, waterTemp: 1, oilTemp: 1, fuel: 1, boost: 1, battery: 1 };
  function tempOf(c, u) { return u === 'metric' ? [String(Math.round(c)), '\u00b0C'] : [String(Math.round(c * 9 / 5 + 32)), '\u00b0F']; }
  var FIELD_ORDER = Object.keys(FIELDS);
  TreadXLApp.FIELDS = FIELD_ORDER;

  // course fields while a course is loaded, a separate set for free drive / recording (like per-mode dashboards)
  P.fieldSet = function () {
    var m = modeOf(this.s.mode).id, set;
    if (m === 'chase') set = this.course ? this.s.fields : this.s.freeFields;
    else {
      // every other mode keeps its own two field sets (course / free drive)
      var mf = this.s.modeFields && typeof this.s.modeFields === 'object' && !Array.isArray(this.s.modeFields) ? this.s.modeFields : (this.s.modeFields = {});
      var key = m + (this.course ? '' : 'Free');
      if (!Array.isArray(mf[key])) mf[key] = MODE_FIELDS[key].slice();
      set = mf[key];
    }
    while (set.length < 3) set.push('speed');
    return set;
  };
  P.setHtml = function (key, el, html) {
    if (this.lastHtml[key] === html) return;
    this.lastHtml[key] = html;
    el.innerHTML = html;
  };

  P.renderAll = function () { this.renderStatus(); this.renderHud(); };

  P.renderStatus = function () {
    var h = this.hud || {};
    if (this.home) this.renderHome();
    this.el.clock.textContent = clockText(this.s.clockSource === 'game' && typeof h.tod === 'number' ? h.tod : null);
    // top center: the mode ("CHASE MODE"), then what's loaded (no RACE / FREE DRIVE words)
    var mode, race = h.race, mdS = modeOf(this.s.mode);
    if (this.rec.active) mode = '<i>REC</i> \u00b7 <b>' + esc(dispName(this.rec.name)) + '</b>';
    else if (race && this.course) mode = '<b>' + esc(dispName(race.name)) + '</b>' +
      (race.state === 'running' ? '' : race.state === 'countdown' ? ' \u00b7 GET READY' : race.state === 'finished' ? ' \u00b7 FINISHED' : ' \u00b7 TO THE START');
    else if (this.course) mode = (this.course.source === 'server' ? 'SERVER \u00b7 ' : this.course.source === 'rally' ? 'RALLY \u00b7 ' : '') + '<b>' + esc(dispName(this.course.name)) + '</b>';
    else mode = '';
    if (!ONYX) mode = '<span class="txl-mtag' + (mode ? '' : ' solo') + '">' + mdS.name + ' MODE</span>' + mode; // (the Onyx Edition: one mode, no tag; v3.3)
    this.setHtml('mode', this.el.mode, mode);
    var icons = '';
    if (h.chase) icons += '<span class="txl-chasetag">' + esc(h.chase.lost ? 'LOST' : (h.chase.name || '')) + '</span>';
    if (this.rec.active) icons += '<span class="txl-rec">REC</span>';
    icons += h.ok === false ? '<span class="txl-nogps">NO GPS</span>' : (h.chase ? G.sat : '') + G.gps;
    // the map's air temperature right now ("-" when the level has none)
    var tc = typeof h.tempC === 'number' && isFinite(h.tempC) ? h.tempC : null;
    var tTxt = tc == null ? '-' : this.s.units === 'metric' ? Math.round(tc) + '\u00b0C' : Math.round(tc * 9 / 5 + 32) + '\u00b0F';
    icons += '<span class="txl-temp' + (tc == null ? ' none' : '') + '" title="Air temperature (in game)"><b>' + tTxt + '</b></span>';
    icons += G.power;
    this.setHtml('icons', this.el.icons, icons);
    // with a route loaded the chase map is "Co-Pilot Mode"
    var cp = !!this.course;
    this.setHtml('chasebtn', this.el.chaseBtn, cp ? '<b class="cp">CO-PILOT<br>MODE</b>' : G.chase + '<span>CHASE</span>');
    this.el.chaseBtn.classList.toggle('copilot', cp);
    this.el.chaseBtn.title = cp ? 'Co-Pilot Mode (chase map)' : 'Chase map';
    // REC / STOP button on the main screen
    var recHtml;
    if (this.rec.active) {
      var d = fmtDist((h.rec && h.rec.dist) || 0, this.s.units);
      recHtml = G.stop + '<span>STOP</span><small>' + esc(d.v + ' ' + d.u) + '</small>';
    } else recHtml = G.rec + '<span>REC</span>';
    this.setHtml('recbtn', this.el.recBtn, recHtml);
    this.el.recBtn.classList.toggle('on', !!this.rec.active);
    this.root.setAttribute('data-rec', this.rec.active ? '1' : '0'); // recording: STOP, MARK, UNDO, MENU
  };

  P.renderScale = function () {
    var sb = scaleBar(this.effZoom(), this.s.units);
    var html = '<span>' + esc(sb.label) + '</span><i style="width:' + sb.px.toFixed(0) + 'px"></i>';
    this.setHtml('scale', this.el.scale, html);
  };

  P.renderHud = function () {
    var h = this.hud || {}, u = this.s.units;
    var tod = this.s.clockSource === 'game' && typeof h.tod === 'number' ? h.tod : null;
    this.applyTheme();
    this.renderStatus();
    var html = '', set = this.fieldSet(), now = Date.now();
    // Tuner gauges: the UI's electrics stream when it comes, else what the game sends (TreadXLGPS.setTelemetry)
    var tl = this.telx && now - (this.telAt || 0) < 2500 ? this.telx : null;
    var ve = this.elx && now - (this.elxAt || 0) < 2500 ? this.elx : tl;
    var needTel = set.some(function (k) { return TEL_FIELDS[k]; }) || this.panelKind() === 'gauges';
    if (needTel !== this.telOn) { this.telOn = needTel; this.call('setTelemetry', needTel ? 'true' : 'false'); }
    set.forEach(function (key, i) {
      var F = FIELDS[key] || FIELDS.speed;
      var label = typeof F.k === 'function' ? F.k(u) : F.k;
      var val = null;
      try { val = F.f({ h: h, u: u, tod: tod, e: ve, t: tl }); } catch (_) { val = null; }
      html += '<div class="txl-field" data-act="field" data-i="' + i + '"><div class="k">' + esc(label) + '</div>' +
        (val ? '<div class="v">' + esc(val[0]) + '<small>' + esc(val[1] || '') + '</small></div>' : '<div class="v dim">--</div>') + '</div>';
    });
    this.setHtml('fields', this.el.fields, html);

    var sp = fmtSpeed(h.speed, u);
    this.el.speedbox.querySelector('.v').textContent = h.ok === false ? '--' : sp.v;
    this.el.speedbox.querySelector('.u').textContent = sp.u.toUpperCase();
    var over = h.alert && h.alert.kind === 'overspeed';
    this.el.speedbox.classList.toggle('over', !!over);
    var z = h.zone;
    this.el.limit.className = 'txl-limit' + (u === 'metric' ? ' round' : '') + (z ? ' show' : '');
    if (z) this.el.limit.querySelector('.n').textContent = String(mphTo(z.limitMph, u));
    this.renderScale();

    var hd = this.camState ? this.camState.h : (Number(h.heading) || 0);
    this.el.orient.querySelector('svg').style.transform = 'rotate(' + (this.s.northUp ? 0 : -hd) + 'deg)';
    this.el.orient.querySelector('span').textContent = this.s.northUp ? 'N UP' : 'TRK UP';

    this.renderAlert(h);
    this.renderDeck(h);
    this.renderChips(h);
    this.renderRace(h);
    this.renderPnBar(h);
  };
  // next pacenotes as BeamNG-style tiles, bottom right of the map (the co-driver reads them out)
  P.renderPnBar = function (h) {
    var pn = h.pacenotes, u = this.s.units, html = '';
    if (pn && this.s.pnBar && pn.next.length) {
      var max = this.root.getAttribute('data-compact') === '1' ? 2 : 3;
      html = pn.next.slice(0, max).map(function (n, i) {
        var d = fmtDist(Math.max(0, Number(n.ahead) || 0), u);
        // Chase mode: the words the co-driver says ("SHARP LEFT", cautions and extras below) instead of rally tiles
        var body = pn.style === 'chase' && n.ct ? '<div class="pn-word">' + esc(n.ct) + (n.cx ? '<small>' + esc(n.cx) + '</small>' : '') + '</div>' : pnTiles(n.vis);
        return '<div class="pn-item' + (i === 0 ? ' first' : '') + (n.called ? ' called' : '') + '"><div class="pn-ahead">' + esc(d.v) + '<small>' + esc(d.u) + '</small></div>' + body + '</div>';
      }).join('');
    }
    this.setHtml('pnbar', this.el.pnbar, html);
  };

  P.renderAlert = function (h) {
    var a = h.alert, u = this.s.units, el = this.el.alert;
    // with the separate Alerts app on screen the GPS can leave course alerts to it (race notices always show here)
    if (a && !this.s.alertsOnGps && !/^race/.test(String(a.kind))) a = null;
    // the race result box already says FINISH
    if (a && a.kind === 'finish' && h.race && h.race.result && h.race.state === 'finished' && h.race.resultAge < RESULT_SECONDS) a = null;
    if (!a) { el.className = 'txl-alert'; this.lastHtml.alert = ''; return; }
    var ttl = '', sub = '', ico = '';
    var lim = a.limitMph != null ? mphTo(a.limitMph, u) + ' ' + (u === 'metric' ? 'KM/H' : 'MPH') : '';
    var dist = a.meters != null ? fmtDist(a.meters, u) : null;
    var iconImg = function (f) { return '<img src="' + ICON_DIR + f + '">'; };
    switch (a.kind) {
      case 'overspeed': ttl = 'SLOW DOWN \u00b7 ' + lim; sub = '+' + mphTo(a.overMph || 0, u) + ' over the speed zone limit'; ico = iconImg('Tread_XL_icon_speedzone.svg'); break;
      case 'offCourse': ttl = 'OFF COURSE'; sub = (dist ? dist.v + ' ' + dist.u : '') + ' from the course line' + (typeof a.forT === 'number' ? ' \u00b7 off ' + fmtRace(a.forT) : ''); ico = G.warn; break;
      case 'wrongWay': ttl = 'WRONG WAY'; sub = 'You are driving against the course'; ico = G.wrong; break;
      case 'vcpMissed': ttl = 'MISSED ' + (a.label || 'VCP'); sub = 'You passed outside the VCP radius'; ico = iconImg('Tread_XL_icon_checkpoint.svg'); break;
      case 'vcpCleared': ttl = (a.label || 'VCP') + ' CLEARED'; sub = 'Virtual checkpoint logged'; ico = iconImg('Tread_XL_icon_checkpoint.svg'); break;
      case 'vcpAhead': ttl = a.label || 'VCP'; sub = 'Virtual checkpoint in ' + (dist ? dist.v + ' ' + dist.u : ''); ico = iconImg('Tread_XL_icon_checkpoint.svg'); break;
      case 'dangerAhead': case 'hazardAhead': {
        var dz = a.kind === 'dangerAhead', mi = /^Tread_XL_icon_[\w-]+\.svg$/.test(String(a.icon || '')) ? a.icon : dz ? 'Tread_XL_icon_death.svg' : 'Tread_XL_icon_warning.svg';
        ttl = a.label || (dz ? 'DANGER' : 'HAZARD'); sub = (dz ? 'Danger' : 'Hazard') + ' ahead \u00b7 ' + (dist ? dist.v + ' ' + dist.u : ''); ico = iconImg(mi); break;
      }
      case 'zoneAhead': ttl = 'SPEED ZONE AHEAD'; sub = lim + ' in ' + (dist ? dist.v + ' ' + dist.u : ''); ico = iconImg('Tread_XL_icon_speedzone.svg'); break;
      case 'finish': ttl = 'FINISH'; sub = 'End of course'; ico = G.flag; break;
      case 'raceStaging': ttl = 'TRAVEL TO STARTING LINE'; sub = (dist ? dist.v + ' ' + dist.u + ' to the start' : 'Drive to the start of the course') + (h.race && h.race.name ? ' of ' + dispName(h.race.name) : ''); ico = G.flag; break;
      case 'raceReady': ttl = 'AT THE STARTING LINE'; sub = 'Press START RACE for the 10 second countdown'; ico = G.flag; break;
      case 'raceJump': ttl = 'JUMP START'; sub = 'Back to the line and press START RACE again'; ico = G.warn; break;
      default: ttl = String(a.kind || ''); break;
    }
    var f3 = a.kind === 'dangerAhead' || a.kind === 'hazardAhead' ? a.kind + '|' + (a.id != null ? a.id : a.label) : '';
    el.className = 'txl-alert show ' + (a.kind === 'dangerAhead' ? 'danger' : a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : a.level === 'ok' ? 'ok' : 'info') + (f3 ? ' flash3' : '');
    if (f3 && f3 !== this.alertFlashKey) { el.classList.remove('flash3'); void el.offsetWidth; el.classList.add('flash3'); } // 3 flashes per marker
    this.alertFlashKey = f3;
    this.setHtml('alert', el, '<div class="aico">' + ico + '</div><div class="txt"><div class="ttl">' + esc(ttl) + '</div><div class="sub">' + esc(sub) + '</div></div>');
  };

  // small cards on the map: race clock, next VCP, next pit
  P.renderChips = function (h) {
    var u = this.s.units, html = '';
    var chip = function (cls, ico, k, v, sub) {
      return '<div class="txl-chip ' + cls + '"><div class="ci">' + ico + '</div><div class="ct"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
        (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div></div>';
    };
    var dv = function (m) { var d = fmtDist(m, u); return esc(d.v) + '<small>' + esc(d.u) + '</small>'; };
    var r = h.race;
    if (r && r.state === 'running') {
      var last = r.splits && r.splits.length ? r.splits[r.splits.length - 1] : null;
      html += chip('race', G.race, 'RACE TIME', esc(fmtRace(r.t)), last ? last.label + ' ' + fmtRace(last.t) : (r.best ? 'BEST ' + fmtRace(r.best) : ''));
    }
    if (this.s.chipVcp && h.nextVcp) html += chip('vcp', '<img src="' + ICON_DIR + 'Tread_XL_icon_checkpoint.svg">', h.nextVcp.label || 'NEXT VCP', dv(h.nextVcp.ahead));
    if (this.s.chipPit && h.nextPit) html += chip('pit', '<img src="' + ICON_DIR + 'Tread_XL_icon_repair.svg">', h.nextPit.label || 'NEXT PIT', dv(h.nextPit.ahead));
    this.setHtml('chips', this.el.chips, html);
  };
  // "Off course 2 (0:02.7) \u00b7 Speeding 1 \u00b7 Resets 1", or "Clean run"
  function runWarnings(res) {
    var parts = [];
    [['offCourse', 'Off course'], ['wrongWay', 'Wrong way'], ['overspeed', 'Speeding'], ['jump', 'Jump starts'], ['reset', 'Resets'], ['recover', 'Recoveries'], ['damage', 'Damage']].forEach(function (k) {
      if (res[k[0]] > 0) parts.push(k[1] + ' ' + res[k[0]] + (k[0] === 'offCourse' && res.offTime > 0 ? ' (' + fmtRace(res.offTime) + ')' : ''));
    });
    return parts.length ? parts.join(' \u00b7 ') : 'Clean run';
  }
  // countdown (white on a black box), finish result, and the RACE / END RACE button left of REC
  P.renderRace = function (h) {
    var r = h.race, u = this.s.units;
    var n = '';
    if (r && r.state === 'countdown' && typeof r.count === 'number') n = String(Math.max(1, Math.ceil(r.count - 1e-6)));
    else if (r && r.state === 'running' && typeof r.t === 'number' && r.t < 1.5) n = 'GO';
    this.el.count.className = 'txl-count' + (n ? ' show' : '') + (n === 'GO' ? ' go' : '');
    this.setHtml('count', this.el.count, n ? '<div class="n">' + n + '</div><div class="l">' + (n === 'GO' ? esc(dispName(r.name)) : 'GET READY') + '</div>' : '');
    var res = r && r.result, resKey = res ? r.name + '|' + res.t + '|' + res.prevBest : '';
    var showRes = !!(res && typeof r.resultAge === 'number' && r.resultAge < RESULT_SECONDS && r.state === 'finished' && this.resultClosed !== resKey);
    this.resultKey = resKey;
    var rh = '';
    if (showRes) {
      var bestLine = res.isBest ? (res.prevBest ? 'NEW BEST \u00b7 ' + fmtRace(res.t - res.prevBest) : 'FIRST TIME ON THIS ROUTE') : 'BEST ' + fmtRace(res.best) + ' \u00b7 +' + fmtRace(res.t - res.best);
      rh = '<div class="h">FINISH \u00b7 ' + esc(dispName(r.name)) + '</div><div class="n">' + esc(fmtRace(res.t)) + '</div><div class="b' + (res.isBest ? ' best' : '') + '">' + esc(bestLine) + '</div>' +
        (res.total ? '<div class="m">VCPs ' + res.cleared + '/' + res.total + (res.missed ? ' \u00b7 ' + res.missed + ' MISSED' : '') + '</div>' : '') +
        '<div class="m">' + esc(runWarnings(res)) + '</div>' +
        '<div class="cl"><span>Clears in ' + Math.max(1, Math.ceil(RESULT_SECONDS - r.resultAge)) + ' s</span><button class="x" data-act="closeResult" title="Close the results">' + G.close + '<i>CLOSE</i></button></div>';
    }
    this.el.result.className = 'txl-result' + (showRes ? ' show' : '');
    this.setHtml('result', this.el.result, rh);
    var bh = '', bc = '';
    var canRace = this.course && arr(this.course.flat).length >= 4 && !this.rec.active;
    if (r && (r.state === 'staging' || r.state === 'finished') && r.ready) { bh = G.race + '<span>START RACE</span>'; bc = 'go'; }
    else if (r && (r.state === 'staging' || r.state === 'finished')) {
      // not on the line yet: drive there, or tap twice to be moved there
      var tp = this.armed === 'raceTp', dd = typeof r.dist === 'number' ? fmtDist(r.dist, u) : null;
      bh = G.race + '<span>' + (tp ? 'TAP: MOVE TO START' : 'TO START') + '</span>' + (!tp && dd ? '<small>' + esc(dd.v + ' ' + dd.u) + '</small>' : '');
      bc = 'stage' + (tp ? ' armed' : '');
    }
    else if (r && (r.state === 'countdown' || r.state === 'running')) { var armed = this.armed === 'raceEnd'; bh = G.stop + '<span>' + (armed ? 'TAP TO END' : 'END RACE') + '</span>'; bc = 'end' + (armed ? ' armed' : ''); }
    else if (!r && canRace) { bh = G.race + '<span>START</span>'; bc = 'idle'; }
    this.el.raceBtn.className = 'txl-abtn racebtn ' + (bh ? bc : 'hidden');
    this.setHtml('racebtn', this.el.raceBtn, bh);
    this.el.actions.classList.toggle('has-race', !!bh);
  };

  P.renderDeck = function (h) {
    var u = this.s.units, html = '', cards = 0;
    var maxCards = Math.max(1, Math.floor(((this.el.deck.clientHeight || 300) - 30) / ((parseFloat(this.root.style.fontSize) || 10) * 6.5)));
    var card = function (cls, ico, distHtml, lbl, sub, badge) {
      cards++;
      return '<div class="txl-card ' + cls + '"><div class="ico">' + ico + '</div><div class="body">' +
        (distHtml ? '<div class="dist">' + distHtml + '</div>' : '') +
        '<div class="lbl">' + esc(lbl) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>' + (badge || '') + '</div>';
    };
    var dh = function (m) { var d = fmtDist(m, u); return esc(d.v) + '<small>' + esc(d.u) + '</small>'; };
    var head = '';

    if (h.chase) {
      var c = h.chase;
      if (c.lost) {
        html += card('chase lost first', G.arrow, '', c.name || 'Race vehicle', 'Signal lost \u00b7 vehicle left', '<span class="badge bad">LOST</span>');
      } else {
        var rel = this.s.northUp ? (c.bearing || 0) : ((c.bearing || 0) - (Number(h.heading) || 0));
        var arrow = G.arrow.replace('<svg ', '<svg style="transform:rotate(' + rel + 'deg)" ');
        var parts = [];
        var sp = fmtSpeed(c.speed, u);
        parts.push(sp.v + ' ' + sp.u);
        if (c.s != null) parts.push('RM ' + fmtRM(c.s, u));
        // live tracking says LIVE; delayed (satellite-style) tracking shows how old the last position is
        var cbadge = c.interval > 0 ? ageText(c.age) : 'LIVE';
        html += card('chase first', arrow, c.dist != null ? dh(c.dist) + '<small>' + esc(compass(c.bearing || 0)) + '</small>' : '', c.name || 'Race vehicle', parts.join(' \u00b7 '), '<span class="badge chasebadge">' + esc(cbadge) + '</span>');
      }
    }

    var list = h.next || [];
    if (this.course) {
      var vc = h.vcps;
      head = '<div class="txl-deckhead"><span>Up next</span><span>' + (vc && vc.total ? 'VCP ' + vc.cleared + '/' + vc.total : '') + '</span></div>';
      // route detection: drivers on the course ahead of you, in order with the waypoints (Lua: TreadXLGPS FIELD)
      var field = arr(h.field), items = [];
      list.forEach(function (w) { items.push({ w: w, d: Number(w.ahead) || 0 }); });
      field.forEach(function (p) { items.push({ p: p, d: Number(p.gap) || 0 }); });
      items.sort(function (a, b) { return a.d - b.d; });
      if (!items.length) {
        html += '<div class="txl-card empty"><div class="lbl">No Waypoints Ahead</div><div class="sub">' +
          (h.course && h.course.toFinish != null && h.course.toFinish < 30 ? 'You are at the end of the course.' : 'No more waypoints on this course.') + '</div></div>';
      }
      for (var i = 0; i < items.length && cards < maxCards; i++) {
        var p = items[i].p;
        if (p) {
          var psp = fmtSpeed(p.speed, u), pparts = [psp.v + ' ' + psp.u];
          if (p.s != null) pparts.push('RM ' + fmtRM(p.s, u));
          html += card('racer' + (cards === 0 ? ' first' : ''), G.arrow, dh(p.gap) + '<small>AHEAD</small>', p.name || 'Driver', pparts.join(' \u00b7 '), '<span class="badge racerbadge">ON ROUTE</span>');
          continue;
        }
        var w = items[i].w, info = ICON_BY_FILE[w.icon] || {};
        var sub = [];
        if (w.s != null) sub.push('RM ' + fmtRM(w.s, u));
        if (w.kind === 'zone' && w.limitMph) sub.push(mphTo(w.limitMph, u) + ' ' + (u === 'metric' ? 'km/h' : 'mph'));
        if (info.name && info.name !== w.label && w.kind !== 'vcp') sub.push(info.name);
        var badge = w.status === 'cleared' ? '<span class="badge ok">\u2713</span>' : w.status === 'missed' ? '<span class="badge bad">MISSED</span>' : '';
        html += card(cards === 0 ? 'first' : '', '<img src="' + ICON_DIR + esc(w.icon) + '">', dh(w.ahead), w.label || info.name || 'Waypoint', sub.join(' \u00b7 '), badge);
      }
    } else if (this.rec.active) {
      var r = h.rec || {};
      head = '<div class="txl-deckhead"><span>Recording</span><span>' + (r.pts || 0) + ' pts</span></div>';
      html += card('rec' + (cards ? '' : ' first'), '', dh(r.dist || 0), dispName(r.name || this.rec.name) || 'Recording', (r.marks || 0) + ' waypoint' + (r.marks === 1 ? '' : 's') + ' marked');
      var marks = h.marks || [];
      for (var j = 0; j < marks.length && cards < maxCards; j++) {
        var m = marks[j];
        html += card('', m.kind === 'pacenote' ? '<div class="pn-mini">' + pnTile(pnMain(m.vis)) + '</div>' : '<img src="' + ICON_DIR + esc(m.icon) + '">',
          m.behind != null ? dh(m.behind) + '<small>BACK</small>' : '', m.label || 'Waypoint', m.kind === 'pacenote' ? 'Pacenote' : 'Marked');
      }
    } else {
      head = '<div class="txl-deckhead"><span>Up next</span><span></span></div>';
      html += '<div class="txl-card empty"><div class="lbl">No Waypoints Ahead</div><div class="sub">Press <b>REC</b> to prerun a course, or load one from MENU.</div></div>';
    }
    this.setHtml('deck', this.el.deck, head + html);
  };

  // ---------------------------------------------------------------- per-frame map drawing
  P.loop = function (now) {
    if (this.destroyed) return;
    this.raf = window.requestAnimationFrame(this.loop);
    now = now || (window.performance ? performance.now() : Date.now());
    var dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    try { this.renderFrame(now, dt); } catch (_) { }
  };

  P.renderFrame = function (now, dt) {
    var sz = this.mapSize(), ov = this.ov;
    if (!sz[0] || !sz[1]) return;
    var has = this.updateCamera(now, dt);
    var a = this.anchor();
    ov.xhair.setAttribute('transform', 'translate(' + (sz[0] / 2) + ' ' + (sz[1] / 2) + ')');
    if (!has) { ov.me.setAttribute('visibility', 'hidden'); this.view.layer.style.visibility = 'hidden'; return; }
    var c = this.camState, z = this.effZoom();
    this.view.setCamera(c.x, c.y, c.h, this.s.northUp, z, a[0], a[1]);
    if (Math.abs(z - (this._scaleZ || 0)) / z > 0.03) { this._scaleZ = z; this.renderScale(); }
    // my arrow sits on the anchor; it points up in track-up, along the heading in north-up
    ov.me.setAttribute('visibility', this.hud && this.hud.ok === false ? 'hidden' : 'visible');
    ov.me.setAttribute('transform', 'translate(' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + ') rotate(' + (this.s.northUp ? c.h : 0).toFixed(1) + ')');
    this.buildWorldLayers();
    this.renderOthers(sz);
    this.renderPins(sz);
    this.renderStartOverlay(a);
    this.renderChaseOverlay(a);
  };
  P.renderStartOverlay = function (me) {
    var g = this.ov.start, r = this.hud && this.hud.race;
    if (!(r && (r.state === 'staging' || r.state === 'countdown') && typeof r.sx === 'number' && this.view.cam && !r.ready)) { g.setAttribute('visibility', 'hidden'); return; }
    if (!g.firstChild) {
      svgEl('line', { class: 'start-line' }, g);
      var mk = svgEl('g', { class: 'start-mk' }, g);
      svgEl('circle', { r: 13, class: 'start-dot' }, mk);
      var fl = svgEl('image', { x: -9, y: -9, width: 18, height: 18 }, mk);
      setHref(fl, 'data:image/svg+xml;utf8,' + encodeURIComponent(G.race.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')));
      svgEl('text', { y: 27, 'text-anchor': 'middle', class: 'pin-label' }, mk).textContent = 'START';
    }
    g.setAttribute('visibility', 'visible');
    var p = this.view.toLocal(r.sx, r.sy), line = g.querySelector('line');
    line.setAttribute('x1', me[0]); line.setAttribute('y1', me[1]); line.setAttribute('x2', p[0]); line.setAttribute('y2', p[1]);
    g.querySelector('.start-mk').setAttribute('transform', 'translate(' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ')');
  };

  // course line, sharp turns, speed-zone dashes, recorded trail and VCP rings (world coords, rebuilt on change)
  P.buildWorldLayers = function () {
    var c = this.course, st = this.vcpStates();
    var key = [c ? c.name + c.source : '', c ? c.flat.length : 0, this.trail.length, this.s.sharpTurns, this.wpts.wpts.length,
      JSON.stringify(st)].join('|');
    if (key === this.worldKey) return;
    this.worldKey = key;
    var V = this.view, g = V.gCourse;
    while (g.firstChild) g.removeChild(g.firstChild);
    if (c && c.flat.length >= 4) {
      var full = pathD(c.drawFlat, 0, c.drawFlat.length / 2 - 1);
      svgEl('path', { d: full, class: 'course-casing', 'data-px': 8 }, g);
      svgEl('path', { d: full, class: 'course', 'data-px': 5 }, g);
      if (this.s.sharpTurns && c.turns) {
        [1, 2, 3].forEach(function (L) {
          c.turns[L].forEach(function (s) { svgEl('path', { d: pathD(c.flat, s[0], s[1]), class: 'turn' + L, 'data-px': 5 }, g); });
        });
      }
      var zones = c.zones || [];
      if (zones.length) {
        var cum = [0], n = c.flat.length / 2;
        for (var i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(c.flat[2 * i] - c.flat[2 * i - 2], c.flat[2 * i + 1] - c.flat[2 * i - 1]);
        zones.forEach(function (zn) {
          var i0 = 0, i1 = n - 1;
          while (i0 < n - 1 && cum[i0 + 1] < zn.s0) i0++;
          while (i1 > 0 && cum[i1 - 1] > zn.s1) i1--;
          if (i1 > i0) svgEl('path', { d: pathD(c.flat, i0, i1), class: 'zone-seg', 'data-px': 2.5, 'data-dashpx': '2 3' }, g);
        });
      }
    }
    var tg = V.gTrail;
    while (tg.firstChild) tg.removeChild(tg.firstChild);
    if (this.trail.length >= 4) {
      var tf = simplify(this.trail, 0.6);
      svgEl('path', { d: pathD(tf, 0, tf.length / 2 - 1), class: 'trail', 'data-px': 3.5 }, tg);
    }
    var rg = V.gRings;
    while (rg.firstChild) rg.removeChild(rg.firstChild);
    arr(this.wpts.wpts).forEach(function (w) {
      if (w.kind !== 'vcp') return;
      svgEl('circle', { cx: w.x, cy: -w.y, r: w.radius || 37, class: 'vcp-ring' + (st[w.id] ? ' ' + st[w.id] : ''), 'data-px': 1.5, 'data-dashpx': '4 3' }, rg);
    });
    V.strokeZoom = 0; // new elements need their stroke widths
  };
  P.vcpStates = function () {
    var out = {};
    arr(this.hud && this.hud.vcpStates).forEach(function (v) { if (v && v.id != null) out[v.id] = v.st; });
    return out;
  };
  P.renderPins = function (sz) {
    var V = this.view, g = this.ov.pins, list = arr(this.wpts.wpts);
    var key = list.map(function (w) { return w.id + w.icon + (w.label || ''); }).join(',');
    if (g.getAttribute('data-k') !== key) {
      g.setAttribute('data-k', key);
      while (g.firstChild) g.removeChild(g.firstChild);
      list.forEach(function (w) {
        var pg = svgEl('g', null, g);
        if (w.kind === 'pacenote') {
          var t = pnMain(w.vis) || {}, bgc = t.background || {};
          svgEl('rect', { x: -10, y: -10, width: 20, height: 20, rx: 4, fill: bngColor(bgc.color, '#2a2e34'), stroke: bngColor(bgc.strokeColor, '#111'), 'stroke-width': 2, class: 'pn-pin' }, pg);
          var gg = svgEl('g', { transform: 'translate(-7.5 -7.5) scale(0.625)' + (t.isLeft ? ' translate(24 0) scale(-1 1)' : ''), style: 'color:' + bngColor(t.colorNoteIcon, '#f2f2f2') }, pg);
          gg.innerHTML = PN_GLYPH[t.type] || PN_GLYPH.dot;
          pg.setAttribute('data-pn', '1');
          return;
        }
        var im = svgEl('image', { width: 26, height: 26, x: -13, y: -13 }, pg);
        setHref(im, ICON_DIR + w.icon);
        if (w.kind === 'vcp' || w.kind === 'zone' || w.kind === 'pit' || w.kind === 'start') {
          var t = svgEl('text', { class: 'pin-label', x: 0, y: 26, 'text-anchor': 'middle' }, pg);
          t.textContent = w.label || '';
        }
      });
    }
    var kids = g.childNodes, showLabels = V.cam && V.cam.z > 0.35;
    for (var i = 0; i < list.length && i < kids.length; i++) {
      var p = V.toLocal(list[i].x, list[i].y);
      var vis = p[0] > -40 && p[1] > -40 && p[0] < sz[0] + 40 && p[1] < sz[1] + 40;
      if (vis && list[i].kind === 'pacenote' && !(V.cam && V.cam.z > 0.3)) vis = false; // pacenote pins only when zoomed in
      kids[i].setAttribute('visibility', vis ? 'visible' : 'hidden');
      if (vis) kids[i].setAttribute('transform', 'translate(' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ')');
      var lbl = kids[i].querySelector('text');
      if (lbl) lbl.setAttribute('visibility', showLabels ? 'visible' : 'hidden');
    }
  };
  // other vehicles: arrows (cyan = BeamMP players, grey = AI / parked), optional name tags
  var OTHER_ARROW = 'M0 -9L6.5 7.5 0 4 -6.5 7.5Z';
  P.renderOthers = function (sz) {
    var g = this.ov.others, list = this.s.showOthers ? arr(this.hud && this.hud.others) : [];
    var V = this.view, byId = this._otherEls || (this._otherEls = {}), seen = {};
    var names = this.s.othersNames && V.cam && V.cam.z > 0.2;
    for (var i = 0; i < list.length; i++) {
      var o = list[i], key = String(o.id);
      seen[key] = 1;
      var el = byId[key];
      if (!el) {
        el = svgEl('g', { class: 'other' + (o.mp ? ' mp' : '') }, g);
        svgEl('path', { d: OTHER_ARROW, class: 'other-arrow' }, el);
        var t = svgEl('text', { class: 'other-name', x: 0, y: 19, 'text-anchor': 'middle' }, el);
        t.textContent = o.name || '';
        byId[key] = el;
      }
      var p = V.toLocal(o.x, o.y);
      var vis = p[0] > -30 && p[1] > -30 && p[0] < sz[0] + 30 && p[1] < sz[1] + 30;
      el.setAttribute('visibility', vis ? 'visible' : 'hidden');
      if (!vis) continue;
      el.setAttribute('transform', 'translate(' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ')');
      el.firstChild.setAttribute('transform', 'rotate(' + ((o.h || 0) + V.cam.th).toFixed(1) + ')');
      el.lastChild.setAttribute('visibility', names ? 'visible' : 'hidden');
    }
    for (var k in byId) if (!seen[k]) { if (byId[k].parentNode) byId[k].parentNode.removeChild(byId[k]); delete byId[k]; }
  };
  P.renderChaseOverlay = function (me) {
    var g = this.ov.chase, c = this.hud && this.hud.chase;
    if (!c || c.lost || c.x == null) { while (g.firstChild) g.removeChild(g.firstChild); g.removeAttribute('data-n'); return; }
    if (g.getAttribute('data-n') !== String(c.id)) {
      while (g.firstChild) g.removeChild(g.firstChild);
      g.setAttribute('data-n', String(c.id));
      svgEl('line', { class: 'chase-line' }, g);
      var mk = svgEl('g', { class: 'chase-mk' }, g);
      setHref(svgEl('image', { width: 30, height: 30, x: -15, y: -15 }, mk), APP_DIR + 'raceMarker.svg');
      var tag = svgEl('g', { class: 'chase-tag' }, g);
      svgEl('rect', { rx: 4, ry: 4, height: 18, y: -9 }, tag);
      svgEl('text', { x: 7, y: 4 }, tag);
    }
    var p = this.view.toLocal(c.x, c.y);
    var line = g.querySelector('line'), mkG = g.querySelector('.chase-mk'), tagG = g.querySelector('.chase-tag');
    line.setAttribute('x1', me[0]); line.setAttribute('y1', me[1]); line.setAttribute('x2', p[0]); line.setAttribute('y2', p[1]);
    var rot = (c.heading || 0) + this.view.cam.th; // world heading -> screen
    mkG.setAttribute('transform', 'translate(' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ') rotate(' + rot.toFixed(1) + ')');
    var d = fmtDist(c.dist, this.s.units);
    var text = (c.name || 'Race vehicle') + ' \u00b7 ' + d.v + ' ' + d.u;
    var tx = tagG.querySelector('text');
    if (tx.textContent !== text) {
      tx.textContent = text;
      var w = 14 + text.length * 6.1;
      try { w = tx.getComputedTextLength() + 14; } catch (_) { }
      tagG.querySelector('rect').setAttribute('width', w.toFixed(0));
    }
    tagG.setAttribute('transform', 'translate(' + (p[0] + 18).toFixed(1) + ' ' + (p[1] - 18).toFixed(1) + ')');
  };

  // ---------------------------------------------------------------- sheets
  P.openSheet = function (name) {
    this.sheet = name; this.armed = null; this.renaming = null;
    for (var k in this.el.sheets) this.el.sheets[k].classList.toggle('open', k === name);
    if (!name) { this.releaseInput(); return; } // back to driving
    if (!this.pnInfo && (name === 'mark' || name === 'menu')) this.call('requestPacenoteInfo');
    if (name === 'mark' && this.s.markMode === 'rally' && !this.pnPreview) this.call('pacenotePreview', luaPn(this.s.pnDraft));
    this.renderSheet();
  };
  P.renderSheet = function () {
    if (!this.sheet) return;
    var el = this.el.sheets[this.sheet];
    var html = this.sheet === 'menu' ? this.menuHtml() : this.sheet === 'mark' ? this.markHtml() : this.sheet === 'unlock' ? this.unlockHtml() : this.sheet === 'notice' ? this.noticeHtml() : this.sheet === 'login' ? this.loginHtml() : this.chaseHtml();
    // keep typing focus/caret if an input is being edited
    var active = document.activeElement, focusKey = active && el.contains(active) ? active.getAttribute('data-in') : null;
    var caret = focusKey ? active.selectionStart : null;
    var body = el.querySelector('.txl-sheetbody'), scroll = body ? body.scrollTop : 0;
    el.innerHTML = html;
    var nb = el.querySelector('.txl-sheetbody');
    if (nb) nb.scrollTop = scroll;
    this.wireInputs(el);
    if (focusKey) {
      var again = el.querySelector('[data-in="' + focusKey + '"]');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (_) { } }
    }
  };
  // a click on a text box always ends with the caret in it (some game UI layers swallow the first focus)
  P.wireInputs = function (el) {
    var list = el.querySelectorAll('input.txl-input');
    for (var i = 0; i < list.length; i++) {
      list[i].addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      list[i].addEventListener('click', function (ev) {
        var t = ev.currentTarget;
        ev.stopPropagation();
        if (document.activeElement !== t) { try { t.focus(); } catch (_) { } }
      });
    }
  };
  P.releaseInput = function () {
    var a = document.activeElement;
    if (a && a !== document.body && this.root.contains(a) && a.blur) { try { a.blur(); } catch (_) { } }
  };
  // fallback typing: a small game-drawn window (ImGui) that always gets the keyboard; the text comes back as 'text'
  function kbd(kind) {
    return '<button class="txl-kbd" data-act="kbd" data-v="' + kind + '" title="Type in the game\u2019s own text window">' + G.kbd + '</button>';
  }
  function head(title) {
    return '<div class="txl-sheethead"><h2>' + esc(title) + '</h2><button class="txl-x" data-act="close" title="Close">' + G.close + '</button></div>';
  }
  function seg(k, cur, opts) {
    return '<div class="txl-seg">' + opts.map(function (o) {
      return '<button class="' + (String(cur) === String(o[0]) ? 'on' : '') + '" data-act="set" data-k="' + k + '" data-v="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function btn(act, label, cls, v) {
    return '<button class="txl-btn ' + (cls || '') + '" data-act="' + act + '"' + (v != null ? ' data-v="' + esc(v) + '"' : '') + '>' + label + '</button>';
  }

  P.markHtml = function () {
    var u = this.s.units, cur = this.s.markIcon, info = ICON_BY_FILE[cur] || {};
    var tiles = this.icons.map(function (f) {
      var i = ICON_BY_FILE[f] || { name: f.replace(/^Tread_XL_icon_|\.svg$/g, '').replace(/_/g, ' ') };
      return '<button class="txl-itile' + (f === cur ? ' on' : '') + '" data-act="pickIcon" data-v="' + esc(f) + '"><img src="' + ICON_DIR + esc(f) + '"><span>' + esc(i.name) + '</span></button>';
    }).join('');
    var limitRow = info.kind === 'zone'
      ? '<div class="txl-row"><div class="grow"><div class="t1">Speed limit</div><div class="t2">Applies until an End Zone symbol (or the finish)</div></div><input class="txl-input short" data-in="markLimit" data-enter="markHere" type="number" min="5" max="200" value="' + mphTo(this.s.markLimit, u) + '"><span class="num">' + (u === 'metric' ? 'km/h' : 'mph') + '</span></div>' : '';
    var where = this.course ? (this.course.readOnly ? 'This server course is read-only - save a copy first (MENU \u203a Courses)' : 'Adds to course <b>' + esc(dispName(this.course.name)) + '</b>')
      : this.rec.active ? 'Adds to recording <b>' + esc(dispName(this.rec.name)) + '</b>' : 'Press REC (or load a course) first';
    var panned = Math.abs(this.pan[0]) + Math.abs(this.pan[1]) > 4 && this.view.cam;
    if (ED() === 'chase' || ONYX) this.s.markMode = 'symbols'; // no pacenotes in the Chase or Onyx Edition
    var mtabs = ED() === 'chase' || ONYX ? '' : '<div class="txl-tabs"><button class="txl-tab' + (this.s.markMode !== 'rally' ? ' on' : '') + '" data-act="markMode" data-v="symbols">Symbols</button>' +
      '<button class="txl-tab' + (this.s.markMode === 'rally' ? ' on' : '') + '" data-act="markMode" data-v="rally">Rally pacenote</button></div>';
    if (this.s.markMode === 'rally') return head('Mark Waypoint') + mtabs + '<div class="txl-sheetbody">' + this.rallyHtml(where, panned) + '</div>';
    return head('Mark Waypoint') + mtabs + '<div class="txl-sheetbody">' +
      '<div class="txl-sec"><h3>Symbol</h3><div class="txl-iconsgrid">' + tiles + '</div></div>' +
      '<div class="txl-sec"><h3>Details</h3>' +
      '<div class="txl-row"><div class="grow"><div class="t1">Name</div><div class="t2">Optional - blank uses the symbol name (' + (ONYX ? 'Hazard 2, Note 1' : 'VCP 3, Pit 1...') + ')</div></div><input class="txl-input" type="text" data-in="markLabel" data-enter="markHere" maxlength="32" placeholder="' + esc(info.name || 'Waypoint') + '" value="' + esc(this.s.markLabel) + '">' + kbd('markLabel') + '</div>' +
      limitRow + '</div>' +
      '<div class="txl-note">' + where + '.</div>' +
      '<div class="txl-btnrow">' + btn('markHere', 'Mark at vehicle', 'primary') +
      (panned ? btn('markXhair', 'Mark at crosshair', 'blue') : '') + btn('close', 'Cancel') + '</div>' +
      '<div class="txl-note">Tip: bind <b>Baja75 Navigation Unit: Mark waypoint</b> in Options \u203a Controls to drop this symbol without opening the screen.</div>' +
      '</div>';
  };

  // the pacenote builder: BeamNG's rally vocabulary (from the game through our Lua), preview tiles, listen, mark
  P.rallyHtml = function (where, panned) {
    var info = this.pnInfo, d = this.s.pnDraft, pv = this.pnPreview;
    if (!info) return '<div class="txl-empty">Loading the co-driver\u2026</div>';
    if (!info.available) return '<div class="txl-empty">Rally pacenotes need BeamNG.drive 0.39 or newer (its rally co-driver files).</div>';
    var cat = info.catalog || {}, voiceLabel = '';
    var curVoice = this.s.pnVoice || info.voice;
    arr(info.voices).forEach(function (v) { if (v.id === curVoice) voiceLabel = v.label; });
    var chip = function (key, val, label, on) {
      return '<button class="pn-chip' + (on ? ' on' : '') + '" data-act="pnSet" data-v="' + esc(key + ':' + val) + '">' + esc(label) + '</button>';
    };
    var numbered = /^(one|two|three|four|five|six)$/.test(d.c || '');
    var sev = arr(cat.severities).map(function (sv) {
      var t = Object.assign({}, pnMain(sv.vis) || {}, { isLeft: d.d === -1 });
      return '<button class="pn-sev' + (d.d !== 0 && d.c === sv.id ? ' on' : '') + '" data-act="pnSet" data-v="c:' + esc(sv.id) + '" title="' + esc(sv.id) + '">' + pnTile(t) + '</button>';
    }).join('');
    var html = '<div class="pn-preview">' + (pv && pv.ok ? pnTiles(pv.vis, 'big') : '<div class="pn-tiles big empty"></div>') +
      '<div class="grow"><div class="t1">' + esc(pv && pv.ok ? pv.text : 'Pick a corner or an extra') + '</div><div class="t2">' +
      (voiceLabel ? 'Co-driver: ' + esc(voiceLabel) : 'No BeamNG co-driver voice found') + '</div></div>' +
      btn('pnListen', G.speaker + '<span>Listen</span>', 'blue iconbtn') + '</div>';
    html += '<div class="txl-sec"><h3>Corner</h3><div class="pn-row">' + chip('d', -1, 'LEFT', d.d === -1) + chip('d', 1, 'RIGHT', d.d === 1) + chip('d', 0, 'NO CORNER', d.d === 0) + '</div>' +
      (d.d !== 0 ? '<div class="pn-sevs">' + sev + '</div>' : '') + '</div>';
    if (d.d !== 0 && numbered) {
      html += '<div class="txl-sec"><h3>Length</h3><div class="pn-row">' + chip('len', d.len || '', 'NORMAL', !d.len).replace('data-v="len:"', 'data-v="len:' + esc(d.len || '') + '"') +
        arr(cat.lengths).map(function (l) { return chip('len', l.id, l.label.toUpperCase(), d.len === l.id); }).join('') + '</div></div>';
    }
    if (d.d !== 0) {
      html += '<div class="txl-sec"><h3>Shape</h3><div class="pn-row">' + arr(cat.shapes).map(function (x) { return chip('sh', x.id, x.label.toUpperCase(), d.sh === x.id); }).join('') + '</div></div>';
    }
    html += '<div class="txl-sec"><h3>Caution</h3><div class="pn-row">' + chip('ca', 0, 'NONE', !d.ca) +
      arr(cat.cautions).map(function (x) { return chip('ca', x.id, x.label.toUpperCase(), d.ca === x.id); }).join('') + '</div></div>';
    html += '<div class="txl-sec"><h3>Extras \u00b7 up to 3</h3><div class="pn-row">' +
      arr(cat.modifiers).map(function (x) { return chip('m', x.id, x.label.toUpperCase(), arr(d.m).indexOf(x.id) >= 0); }).join('') + '</div></div>';
    html += '<div class="txl-note">' + where + '. Driving the course, the co-driver reads each pacenote ahead of the corner.</div>' +
      '<div class="txl-btnrow">' + btn('markHere', 'Mark pacenote at vehicle', 'primary') + (panned ? btn('markXhair', 'Mark at crosshair', 'blue') : '') + btn('close', 'Cancel') + '</div>' +
      '<div class="txl-note">Mark the note where the corner starts. Faster: MENU \u203a Courses \u203a <b>Auto pacenotes</b> writes them from the course line. The <b>Mark waypoint</b> key drops this pacenote.</div>';
    return html;
  };

  P.chaseHtml = function () {
    var self = this, u = this.s.units, cur = this.chaseCurrent;
    var rows = this.chaseTargets.map(function (t) {
      var d = t.dist != null ? fmtDist(t.dist, u) : null;
      return '<div class="txl-row click' + (t.id === cur ? ' sel' : '') + '" data-act="chaseSet" data-v="' + esc(t.id) + '"><div class="grow"><div class="t1">' + esc(t.name) + '</div><div class="t2">' + esc(t.model || '') + (t.id === cur ? ' \u00b7 TRACKING' : '') + '</div></div><span class="num">' + (d ? esc(d.v + ' ' + d.u) : '') + '</span></div>';
    }).join('');
    return head('Chase Map') + '<div class="txl-sheetbody">' +
      '<div class="txl-sec"><h3>Track a race vehicle</h3>' + (rows || '<div class="txl-empty">No other vehicles found. In BeamMP, other players\u2019 cars show up here; offline, any AI or spawned vehicle does.</div>') + '</div>' +
      '<div class="txl-sec"><h3>Tracking updates</h3><div class="txl-row"><div class="grow"><div class="t1">Update interval</div><div class="t2">Live, or delayed like satellite team tracking</div></div>' +
      '<div class="txl-seg">' + CHASE_INTERVALS.map(function (o) { return '<button class="' + (self.s.chaseInterval === o[0] ? 'on' : '') + '" data-act="chaseInterval" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div></div>' +
      '<div class="txl-btnrow">' + btn('chaseRefresh', 'Refresh list') + (cur != null ? btn('chaseOff', 'Stop tracking', 'danger') : '') + btn('close', 'Done') + '</div>' +
      '</div>';
  };

  // a folder as it really is on this player's disk (from the game), else where it is inside the BeamNG user folder
  P.folderPath = function (kind) {
    var real = this.real || {}, p = this.paths || {};
    if (real[kind]) return real[kind];
    var rel = p[kind] || (kind === 'gpx' ? 'settings/TreadXLGPS/gpx/<map>' : kind === 'pack' ? 'settings/TreadXLGPS/serverpack' : 'settings/TreadXLGPS/<map>');
    return 'BeamNG user folder \u203a ' + rel;
  };

  P.coursesHtml = function () {
    var self = this, loadedKey = this.course ? courseKey(this.course.name, this.course.source) : null;
    var folder = '<div class="txl-pathrow"><div class="grow"><div class="t2">Your courses are saved to</div><div class="t1 mono path">' + esc(this.folderPath('courses')) + '</div></div>' +
      btn('openFolder', G.folder + '<span>Open folder</span>', 'iconbtn', 'courses') + '</div>';
    var groups = { mine: [], rally: [], server: [], legacy: [] };
    this.routes.forEach(function (r) { (groups[r.source] || groups.mine).push(r); });
    var html = folder;
    var cc = this.commonCourses;
    if (cc && !FULL) html += cc.onyx ? '<div class="txl-note limit"><b>Onyx Edition:</b> ' + cc.used + ' of ' + cc.max + ' routes of your own (recorded, imported or copied). Delete one to make room for another.</div>'
      : cc.free ? '<div class="txl-note limit"><b>Free Edition:</b> ' + cc.used + ' of ' + cc.max + ' course of your own (imported or copied). Delete it to make room for another.</div>'
      : '<div class="txl-note limit"><b>Common Edition:</b> ' + cc.used + ' of ' + cc.max + ' courses of your own (recorded, imported or copied). Delete one to make room for another. Record in single player or on a Baja75 server.</div>';
    ['mine', 'rally', 'server', 'legacy'].forEach(function (src) {
      var list = groups[src];
      if (!list.length && src !== 'mine') return;
      html += '<div class="txl-sec"><h3>' + SOURCE_LABEL[src] + ' \u00b7 ' + list.length + '</h3>';
      if (!list.length) html += '<div class="txl-empty">Nothing recorded on this map yet - press <b>REC</b> on the main screen and drive the course.</div>';
      list.forEach(function (r) {
        var key = courseKey(r.name, r.source), isSel = self.sel === key, isLoaded = key === loadedKey, isRace = isRaceName(r.name);
        var sub = isLoaded ? 'Loaded' : src === 'server' ? 'From the server \u00b7 read-only' : src === 'rally' ? 'From this map\u2019s missions \u00b7 read-only' : src === 'legacy' ? 'Older save \u00b7 rename to move it into your folder' : '';
        var info = self.courseInfo[key];
        if (info && typeof info.best === 'number') sub = (sub ? sub + ' \u00b7 ' : '') + 'Best ' + fmtRace(info.best);
        html += '<div class="txl-row click' + (isSel ? ' sel' : '') + (isLoaded ? ' loaded' : '') + '" data-act="selCourse" data-v="' + esc(key) + '"><div class="grow"><div class="t1">' +
          (isRace ? '<span class="racetag">' + G.race + '</span>' : '') + esc(dispName(r.name)) + '</div>' + (sub ? '<div class="t2">' + esc(sub) + '</div>' : '') + '</div><span class="num">' + (isSel ? '\u25b4' : '\u25be') + '</span></div>';
        if (!isSel) return;
        if (self.renaming === key) {
          html += '<div class="txl-rowacts"><input class="txl-input" type="text" data-in="renameText" data-enter="renameSave" maxlength="48" value="' + esc(self.renameText) + '">' + kbd('renameText') +
            btn('renameSave', 'Save', 'primary') + btn('renameCancel', 'Cancel') + '</div>';
          return;
        }
        var armed = self.armed === 'delCourse:' + key;
        html += '<div class="txl-rowacts">' + btn('load', isLoaded ? 'Reload' : 'Load', 'blue') +
          (ONYX ? '' : btn('raceRoute', G.race + '<span>Race this route</span>', 'primary iconbtn')) +
          (!readOnlySrc(src) ? btn('renameStart', 'Rename') : btn('copyCourse', 'Save a copy')) +
          (!readOnlySrc(src) && !isCommon() ? btn('editNotes', 'Notes') : '') +
          (!readOnlySrc(src) && ED() !== 'chase' && !isCommon() && !ONYX ? btn('autoPn', 'Auto pacenotes') : '') +
          (!readOnlySrc(src) && !isCommon() && info && info.autoPacenotes > 0 ? btn('clearAutoPn', self.armed === 'clearAutoPn:' + key ? 'Confirm remove' : 'Remove auto notes', 'danger' + (self.armed === 'clearAutoPn:' + key ? ' armed' : '')) : '') +
          (isCommon() ? '' : btn('exportGpx', 'Export GPX') + (ONYX ? '' : btn('serverPack', 'Server pack'))) +
          (!readOnlySrc(src) ? btn('delCourse', armed ? 'Confirm delete' : G.trash, 'danger' + (armed ? ' armed' : '')) : '') + '</div>';
        // notes, picture and times (from the course's .notes.txt / .png / .jpg and your race times)
        if (info && (info.notes || info.image || typeof info.best === 'number' || info.pacenotes > 0 || info.author)) {
          var last = info.last && typeof info.last.t === 'number' ? 'Last ' + fmtRace(info.last.t) + (info.last.date ? ' (' + info.last.date + ')' : '') : '';
          html += '<div class="txl-cinfo">' + (info.image ? '<img src="' + esc(String(info.image).charAt(0) === '/' ? info.image : '/' + info.image) + '">' : '') +
            '<div class="ctxt">' + (typeof info.best === 'number' ? '<div class="times">Best <b>' + esc(fmtRace(info.best)) + '</b>' + (info.runs ? ' \u00b7 ' + info.runs + ' run' + (info.runs === 1 ? '' : 's') : '') + (last ? ' \u00b7 ' + esc(last) : '') + '</div>' : '') +
            (info.author ? '<div class="times">Recorded by <b>' + esc(info.author) + '</b></div>' : '') +
            (info.pacenotes > 0 ? '<div class="times">Pacenotes <b>' + info.pacenotes + '</b>' + (info.autoPacenotes ? ' \u00b7 ' + info.autoPacenotes + ' auto' : '') + '</div>' : '') +
            (info.notes ? '<div class="notes">' + esc(info.notes) + '</div>' : '') + '</div></div>';
        }
      });
      html += '</div>';
    });
    if (this.course) html += '<div class="txl-btnrow">' + (ONYX ? '' : btn('resetRun', 'Reset run (VCPs)')) + btn('unload', ONYX ? 'Unload route' : 'Unload course') + '</div>';
    if (ONYX) return html + '<div class="txl-note">Load a route to follow it on the map. Record new ones with <b>REC</b> on the map (up to 3 of your own).</div>';
    html += '<div class="txl-note"><b>Race this route</b> (or <b>RACE</b> on the main screen with a course loaded): drive to the start or tap <b>TO START</b> twice to be moved there, then <b>START RACE</b> within 10 m of the line: 10 second countdown, timed to the finish.</div>';
    return html;
  };

  // MENU > Times: every timed run from race_log.txt (newest first), with its warnings
  P.timesHtml = function () {
    var log = this.runLog || {}, list = arr(log.entries), lg = this.login();
    var where = '<div class="txl-pathrow"><div class="grow"><div class="t2">Run log (a small text file, all maps)</div><div class="t1 mono path">' +
      esc(log.real || log.path || 'settings/TreadXLGPS/race_log.txt') + '</div></div>' + btn('openFolder', G.folder + '<span>Open folder</span>', 'iconbtn', 'log') + '</div>' +
      '<div class="txl-sec"><h3>Driver for race results</h3>' +
      (lg ? '<div class="txl-row"><div class="grow"><div class="t1">' + (lg.on ? 'Signed in as <b>' + esc(lg.name || '') + '</b>' : 'Not signed in') + '</div><div class="t2">' +
        (lg.via === 'beammp' ? 'Your BeamMP name, while on this server' : lg.on ? 'Saved with every recording and run' : 'Sign in to record or race') + '</div></div>' +
        (lg.via === 'beammp' ? '' : lg.on ? btn('loginOpen', 'Change') + btn('signOut', 'Sign out') : btn('loginOpen', 'Sign in', 'primary')) + '</div>' :
      '<div class="txl-row"><div class="grow"><div class="t1">Driver name</div><div class="t2">Saved with every run' + (this.s.driverName ? '' : ' (blank: BeamMP name)') + '</div></div><input class="txl-input" type="text" data-in="driverName" maxlength="40" placeholder="Driver" value="' + esc(this.s.driverName || '') + '">' + kbd('driverName') + '</div>') +
      '<div class="txl-row"><div class="grow"><div class="t1">Race number</div></div><input class="txl-input short" type="text" data-in="raceNumber" maxlength="8" placeholder="#" value="' + esc(this.s.raceNumber || '') + '">' + kbd('raceNumber') + '</div>' +
      '<div class="txl-row"><div class="grow"><div class="t1">Export for scoring</div><div class="t2">A copy of your run log for the race organizer (exports folder)</div></div>' + btn('exportRunLog', 'Export', 'blue') + '</div></div>';
    if (!list.length) {
      return where + '<div class="txl-empty">No timed runs yet. Load a course, then press <b>START</b> on the main screen: every finished run (and every ended one, as DNF) is listed here with its time, vehicle, warnings, resets and recoveries, and each off-course moment.</div>';
    }
    var self = this;
    var rows = list.map(function (e) {
      var dnf = /^DNF/.test(String(e.time || ''));
      var chips = arr(e.counts).map(function (c) {
        return '<span class="txl-cnt' + (c.n > 0 ? ' bad' : '') + '">' + esc(c.k) + ' <b>' + esc(c.n) + '</b></span>';
      }).join('');
      if (e.offTime) chips += '<span class="txl-cnt' + (e.offTime !== '0:00.0' ? ' bad' : '') + '">Time off course <b>' + esc(e.offTime) + '</b></span>';
      // every off-course moment (when, where, how long, resets / recoveries in it) and every damage hit
      var segs = arr(e.segs), hits = arr(e.hits), key = String(e.when || '') + '|' + String(e.course || ''), open = self.runOpen === key;
      var more = '';
      if (segs.length || hits.length) {
        var what = [];
        if (segs.length) what.push(segs.length + ' off-course moment' + (segs.length > 1 ? 's' : ''));
        if (hits.length) what.push(hits.length + ' damage hit' + (hits.length > 1 ? 's' : ''));
        more = '<button class="txl-runmore' + (open ? ' on' : '') + '" data-act="runOpen" data-v="' + esc(key) + '">' + (open ? '\u25be ' : '\u25b8 ') + esc(what.join(' \u00b7 ')) + '</button>';
        if (open) {
          var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : w === 'recovery' ? '' : 's'); };
          more += '<div class="txl-rund">' +
            (segs.length ? '<h4>Off course</h4>' + segs.map(function (g, i) {
              return '<div class="ln"><b>' + (i + 1) + '</b><span>at ' + esc(g.at || '?') + ' \u00b7 RM ' + esc(String(g.rm || '').replace(/ mi$/, '')) + ' \u00b7 off for <i>' + esc(g.dur || '?') + '</i> \u00b7 ' +
                plural(g.resets || 0, 'reset') + ' \u00b7 ' + ((g.recovers || 0) === 1 ? '1 recovery' : (g.recovers || 0) + ' recoveries') + '</span></div>';
            }).join('') : '') +
            (hits.length ? '<h4>Damage</h4>' + hits.map(function (d, i) {
              return '<div class="ln"><b>' + (i + 1) + '</b><span>at ' + esc(d.at || '?') + ' \u00b7 RM ' + esc(String(d.rm || '').replace(/ mi$/, '')) + ' \u00b7 ' + esc(d.parts || '') + '</span></div>';
            }).join('') : '') +
            (e.more ? '<div class="ln"><b></b><span>' + esc(e.more) + ' not listed</span></div>' : '') + '</div>';
        }
      }
      return '<div class="txl-run' + (dnf ? ' dnf' : '') + '"><div class="rh"><div class="grow"><div class="t1">' + esc(e.course || '?') + '</div>' +
        '<div class="t2">' + esc((e.map || '') + ' \u00b7 ' + (e.vehicle || '') + (e.driver || e.number ? ' \u00b7 ' + (e.driver || '') + (e.number ? ' #' + e.number : '') : '')) + '</div></div><div class="rt">' + esc(e.time || '--') + '</div></div>' +
        '<div class="rc">' + chips + '</div>' + more + '<div class="rw">' + esc(e.when || '') + '</div></div>';
    }).join('');
    return where + '<div class="txl-sec"><h3>Timed runs \u00b7 ' + (log.total || list.length) + '</h3>' + rows + '</div>';
  };

  P.shareHtml = function () {
    var self = this, p = this.paths, gpxRoot = p.gpx ? String(p.gpx).replace(/\/[^\/]*$/, '') : 'settings/TreadXLGPS/gpx';
    var gpx = this.gpxFiles.map(function (f) {
      return '<div class="txl-row"><div class="grow"><div class="t1">' + esc(f.name) + '</div><div class="t2">' + esc(f.anyMap ? gpxRoot + ' (any map)' : gpxRoot + '/' + f.file) + '</div></div>' + btn('importGpx', 'Import', 'blue', f.file) + '</div>';
    }).join('');
    var where = function (label, kind) {
      return '<div class="txl-pathrow"><div class="grow"><div class="t2">' + label + '</div><div class="t1 mono path">' + esc(self.folderPath(kind)) + '</div></div>' +
        btn('openFolder', G.folder + '<span>Open</span>', 'iconbtn', kind) + '</div>';
    };
    var importGpx = '<div class="txl-sec"><h3>Import GPX</h3>' +
      (gpx || '<div class="txl-empty">Put <b>.gpx</b> files in the GPX folder below, then press Refresh. Imported courses go to your courses.</div>') +
      '<div class="txl-btnrow">' + btn('refreshFiles', 'Refresh') + btn('openFolder', G.folder + '<span>Open GPX folder</span>', 'iconbtn', 'gpx') + '</div></div>';
    if (ONYX) return importGpx + '<div class="txl-sec"><h3>Export GPX</h3><div class="txl-note">Routes \u203a pick a route \u203a <b>Export GPX</b>: the track and every waypoint go into the GPX folder, with a map picture of the route.</div></div>' +
      '<div class="txl-sec"><h3>Where your files are</h3>' + where('Your routes (this map)', 'courses') + where('GPX files (this map)', 'gpx') + '</div>';
    if (isCommon()) return importGpx + '<div class="txl-sec"><h3>Server courses</h3><div class="txl-note">Courses from a BeamMP server you join show up under <b>Server courses</b> in MENU \u203a Courses by themselves.</div></div>' +
      '<div class="txl-sec"><h3>Where your files are</h3>' + where('Your courses (this map)', 'courses') + where('GPX files (this map)', 'gpx') + '</div>';
    var lk = this.allowed('share') ? '' : '<span class="lk" title="Locked off the Baja75 servers">' + G.lock + '</span>';
    return importGpx +
      '<div class="txl-sec"><h3>Server pack \u00b7 race with friends, no extra HUD needed' + lk + '</h3>' +
      '<div class="txl-note lead">The server pack is for anyone playing with friends on a server who wants a race route without all the extra perks and HUD. ' +
      'Run a race or course just by map guidance and markers: save it as a map file for your own self-hosted BeamMP server, or quick-share the files with others.</div>' +
      '<div class="txl-steps">' +
      '<div><b>1</b>Courses \u203a pick a course \u203a <b>Server pack</b> (repeat for each course). Its notes and picture go with it, and a notes file is started for you.</div>' +
      '<div><b>2</b>Open the server pack folder and add your <b>install notes and pictures</b> next to each course: <span class="mono">&lt;name&gt;.notes.txt</span> and <span class="mono">&lt;name&gt;.png</span> or <span class="mono">.jpg</span>. Racers see them when they pick the course. The README in there explains everything.</div>' +
      '<div><b>3</b>Zip the <span class="mono">settings</span> folder in there and put the zip in your server\u2019s <span class="mono">Resources/Client</span> with the Baja75 Navigation Unit zip. Every racer then sees the courses under <b>Server courses</b>. Or just send the zip to friends.</div>' +
      '</div><div class="txl-btnrow">' + btn('openFolder', G.folder + '<span>Open server pack folder</span>', 'iconbtn', 'pack') + '</div></div>' +
      '<div class="txl-sec"><h3>Course map picture' + lk + '</h3>' +
      '<div class="txl-note">Every <b>Server pack</b> and <b>Export GPX</b> also saves <span class="mono">&lt;name&gt;.map.jpg</span> (1920 \u00d7 1080: course line, start / finish, VCPs, pits, speed zones, pacenotes) and <span class="mono">&lt;name&gt;.info.txt</span> (course, map, distance, elevation change) next to it.</div>' +
      '<div class="txl-row"><div class="grow"><div class="t1">Background</div><div class="t2">Map = the game\u2019s map \u00b7 Satellite = the map\u2019s terrain heightmap</div></div>' +
      seg('snapStyle', this.s.snapStyle, [['map', 'MAP'], ['satellite', 'SATELLITE']]) + '</div></div>' +
      '<div class="txl-sec"><h3>Export GPX' + lk + '</h3><div class="txl-note">Courses \u203a pick a course \u203a <b>Export GPX</b>. The track and every waypoint (VCPs, speed zones with their limit) go into the GPX folder - send the file to other racers and they import it here.</div></div>' +
      '<div class="txl-sec"><h3>Where your files are</h3>' + where('Your courses (this map)', 'courses') + where('GPX files (this map)', 'gpx') + where('Server pack', 'pack') + '</div>';
  };

  P.menuHtml = function () {
    var self = this, t = this.menuTab, u = this.s.units, body = '';
    var tabs = isCommon() ? [['courses', 'Courses'], ['times', 'Times'], ['share', 'Import'], ['display', 'Display']]
      : ONYX ? [['courses', 'Routes'], ['record', 'Record'], ['wpts', 'Waypoints'], ['share', 'Share'], ['display', 'Display']]
      : [['courses', 'Courses'], ['times', 'Times'], ['record', 'Record'], ['wpts', 'Waypoints'], ['share', 'Share'], ['display', 'Display']];
    if (ONYX && t === 'times') t = this.menuTab = 'courses';
    if (isCommon() && (t === 'record' || t === 'wpts')) t = this.menuTab = 'courses';
    var tabHtml = '<div class="txl-tabs">' + tabs.map(function (x) { return '<button class="txl-tab' + (t === x[0] ? ' on' : '') + '" data-act="tab" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
    if (t === 'courses') body = this.coursesHtml();
    else if (t === 'times') body = this.timesHtml();
    else if (t === 'share') body = this.shareHtml();
    else if (t === 'record') {
      if (this.rec.active) {
        var r = (this.hud && this.hud.rec) || {}, d = fmtDist(r.dist || 0, u);
        body = '<div class="txl-sec"><h3>Recording</h3><div class="txl-row"><div class="grow"><div class="t1">' + esc(dispName(this.rec.name)) + '</div><div class="t2">' + esc(d.v + ' ' + d.u) + ' \u00b7 ' + (r.marks || 0) + ' waypoints \u00b7 ' + (r.pts || 0) + ' track points</div></div></div></div>' +
          '<div class="txl-btnrow">' + btn('recStop', 'Stop &amp; save', 'primary') + btn('recDiscard', 'Discard', 'danger') + '</div>' +
          '<div class="txl-note">Saving puts the course in <span class="mono">' + esc(this.paths.courses || 'settings/TreadXLGPS/<map>') + '</span> and loads it right away, with your marks as its waypoints.</div>';
      } else {
        body = '<div class="txl-sec"><h3>New course</h3><div class="txl-row"><div class="grow"><div class="t1">Name</div><div class="t2">Optional - blank = route_date_time (rename it later)</div></div><input class="txl-input" type="text" data-in="recName" data-enter="recStart" maxlength="48" placeholder="e.g. Baja 250 Loop" value="' + esc(this.recName || '') + '">' + kbd('recName') + '</div></div>' +
          '<div class="txl-btnrow">' + btn('recStart', 'Start recording', 'primary') + '</div>' +
          '<div class="txl-note">Quickest way: the <b>REC</b> button on the main screen, or bind <b>Baja75 Navigation Unit: Start / stop recording</b> in Options \u203a Controls. A track point is stored every 4 m; use MARK for VCPs, speed zones, pits and hazards as you go.</div>';
      }
    } else if (t === 'wpts') {
      var list = arr(this.wpts.wpts);
      var owner = this.wpts.owner === 'rec' ? 'recording ' + dispName(this.rec.name) : this.course ? dispName(this.course.name) : '';
      var ro = this.wpts.owner === 'course' && this.course && this.course.readOnly;
      var wrows = list.map(function (w) {
        var armed = self.armed === 'delWpt:' + w.id;
        var meta = [];
        if (w.s != null) meta.push('RM ' + fmtRM(w.s, u));
        if (w.kind === 'zone' && w.limitMph) meta.push(mphTo(w.limitMph, u) + ' ' + (u === 'metric' ? 'km/h' : 'mph'));
        return '<div class="txl-row">' + (w.kind === 'pacenote' ? '<div class="ri pn-mini">' + pnTile(pnMain(w.vis)) + '</div>' : '<img class="ri" src="' + ICON_DIR + esc(w.icon) + '">') +
          '<div class="grow"><div class="t1">' + esc(w.label || 'Waypoint') + (w.auto ? ' <span class="pn-auto">AUTO</span>' : '') + '</div><div class="t2">' + esc(meta.join(' \u00b7 ')) + '</div></div>' +
          (ro ? '' : btn('delWpt', armed ? 'Confirm' : G.trash, 'danger' + (armed ? ' armed' : ''), w.id)) + '</div>';
      }).join('');
      body = '<div class="txl-sec"><h3>Waypoints' + (owner ? ' \u00b7 ' + esc(owner) : '') + '</h3>' + (wrows || '<div class="txl-empty">No waypoints yet. Press REC or load a course, then use MARK.</div>') + '</div>';
    } else {
      var mi = this.mapInfo || {};
      var mapTxt = this.mapState === 'roads' || this.mapState === 'terrain'
        ? (mi.level || '') + ' \u00b7 ' + (mi.roads ? mi.roads + ' roads' : 'no roads yet') + ' \u00b7 ' + (mi.tiles ? mi.tiles + ' terrain image' + (mi.tiles > 1 ? 's' : '') : 'no terrain image')
        : 'Waiting \u00b7 ' + (this.mapReason || 'asking the game for the road network');
      var about = 'Leshii413 | Baja75 Series';
      body = '<div class="txl-sec"><h3>Units &amp; map</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Units</div></div>' + seg('units', u, [['imperial', 'MI / MPH'], ['metric', 'KM / KM/H']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Map orientation</div></div>' + seg('northUp', this.s.northUp ? 1 : 0, [[0, 'TRACK UP'], [1, 'NORTH UP']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Auto zoom</div><div class="t2">Zooms out with speed</div></div>' + seg('autoZoom', this.s.autoZoom ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Terrain image brightness</div></div><input class="txl-range" type="range" min="0.3" max="1" step="0.05" data-in="mapOpacity" value="' + this.s.mapOpacity + '"></div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Map data</div><div class="t2">' + esc(mapTxt) + '</div></div>' + btn('reloadMap', 'Reload map') + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Other vehicles</div><div class="t2">Players and AI within 3 km</div></div>' + seg('showOthers', this.s.showOthers ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Vehicle names</div></div>' + seg('othersNames', this.s.othersNames ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Dark mode</div><div class="t2">Night map colours. Auto = from 7 PM to 6:30 AM (in-game time when the clock uses it)</div></div>' + seg('darkMode', this.s.darkMode, [['off', 'OFF'], ['on', 'ON'], ['auto', 'AUTO']]) + '</div></div>' +
        '<div class="txl-sec"><h3>On the map</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Distance to next VCP</div><div class="t2">Card above the speed</div></div>' + seg('chipVcp', this.s.chipVcp ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Distance to next pit</div><div class="t2">Pit symbols on the loaded course</div></div>' + seg('chipPit', this.s.chipPit ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        (PLUS() ? '<div class="txl-row"><div class="grow"><div class="t1">Clean map</div><div class="t2">Only the route and your speed. Tap the map to see the buttons for a few seconds</div></div>' + seg('cleanMap', this.s.cleanMap ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
          (this.s.cleanMap ? '' :
          '<div class="txl-row"><div class="grow"><div class="t1">Map buttons</div><div class="t2">Zoom, track up / north up, center</div></div>' + seg('mapBtns', this.s.mapBtns ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
          '<div class="txl-row"><div class="grow"><div class="t1">Bottom buttons</div><div class="t2">Race, PASS, REC, MARK, Co-pilot, MENU (hidden: tap the map; HOME \u203a Settings opens the menu)</div></div>' + seg('actBtns', this.s.actBtns ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
          '<div class="txl-row"><div class="grow"><div class="t1">Data boxes</div><div class="t2">The boxes along the top of the map</div></div>' + seg('showFields', this.s.showFields ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
          '<div class="txl-row"><div class="grow"><div class="t1">Speed box</div><div class="t2">Speed and speed limit</div></div>' + seg('showSpeed', this.s.showSpeed ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
          '<div class="txl-row"><div class="grow"><div class="t1">Scale bar</div></div>' + seg('showScale', this.s.showScale ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>') : '') + '</div>' +
        '<div class="txl-sec"><h3>Clock &amp; sound</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Clock</div><div class="t2">Status bar and the Time field</div></div>' + seg('clockSource', this.s.clockSource, [['pc', 'COMPUTER'], ['game', 'IN-GAME']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Sounds</div><div class="t2">Start-up chime and race countdown. Your own chime: settings/TreadXLGPS/sounds/startup.ogg</div></div>' + seg('sound', this.s.sound ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Start-up chime volume</div></div>' + seg('chimeVol', String(this.s.chimeVol), [['0.3', '30 %'], ['0.6', '60 %'], ['1', '100 %']]) + '</div></div>' +
        (ED() === 'chase' || ONYX ? '' : '<div class="txl-sec"><h3>Rally pacenotes</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Co-driver calls</div><div class="t2">Reads the pacenotes of a loaded course with BeamNG\u2019s rally co-driver</div></div>' + seg('pnCalls', this.s.pnCalls, [['on', 'ON'], ['race', 'RACES ONLY'], ['off', 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Call timing</div><div class="t2">How early before the corner</div></div>' + seg('pnLead', this.s.pnLead, [['early', 'EARLY'], ['normal', 'NORMAL'], ['late', 'LATE']]) + '</div>' +
        (this.pnInfo && arr(this.pnInfo.voices).length ? '<div class="txl-row"><div class="grow"><div class="t1">Co-driver voice</div><div class="t2">BeamNG\u2019s own voicepacks</div></div>' +
          seg('pnVoice', this.s.pnVoice || this.pnInfo.voice, arr(this.pnInfo.voices).map(function (v) { return [v.id, v.label.toUpperCase()]; })) + '</div>' : '') +
        '<div class="txl-row"><div class="grow"><div class="t1">Music with co-driver calls</div><div class="t2">Chase and Rally: music pauses while the co-driver reads a course\u2019s pacenotes, and plays again after</div></div>' + seg('musicWithCalls', this.s.musicWithCalls ? 1 : 0, [[0, 'MUSIC WAITS'], [1, 'PLAY ANYWAY']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Pacenote bar</div><div class="t2">Next notes as tiles on the map</div></div>' + seg('pnBar', this.s.pnBar ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Pacenotes app</div><div class="t2">The separate pop-up (HUD apps \u203a Baja75 Navigation Unit - Pacenotes): the notes the co-driver calls until you pass them, the next notes all the time, or nothing</div></div>' +
          seg('pnPop', this.s.pnPop || 'called', [['called', 'WHEN CALLED'], ['next', 'NEXT NOTES'], ['off', 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">BeamNG pacenote display</div><div class="t2">Also sends the tiles to the game\u2019s own rally pacenote display when it\u2019s on screen</div></div>' + seg('pnNative', this.s.pnNative ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div></div>') +
        '<div class="txl-sec"><h3>Alerts</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Off-course warning</div><div class="t2">Distance from the course line before OFF COURSE' + (u === 'metric' ? '' : ' (15 m = 49 ft)') + '</div></div>' +
          seg('offCourseM', this.s.offCourseM, [[15, '15 M'], [30, '30 M'], [60, '60 M']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Alerts on the GPS screen</div><div class="t2">Hide them here if you use the separate Alerts app</div></div>' + seg('alertsOnGps', this.s.alertsOnGps ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Alerts app shows</div><div class="t2">Faults = wrong way, off course, over the limit, missed VCP, jump start</div></div>' + seg('alertsMode', this.s.alertsMode, [['faults', 'FAULTS'], ['all', 'ALL ALERTS']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Flashing warnings</div><div class="t2">In the Alerts app</div></div>' + seg('alertsFlash', this.s.alertsFlash ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        (ONYX ? '' : '<div class="txl-row"><div class="grow"><div class="t1">PASS button</div><div class="t2">During a race. Hidden, its key still works (Options \u203a Controls)</div></div>' + seg('passBtn', this.s.passBtn ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>') + '</div>' +
        '<div class="txl-sec"><h3>Run log</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Damage log</div><div class="t2">Timed runs also list the parts damaged in each crash (MENU \u203a Times and race_log.txt)</div></div>' + seg('damageLog', this.s.damageLog ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div></div>' +
        '<div class="txl-sec"><h3>Modes &amp; screens</h3>' +
        (MODES.length > 1 ? '<div class="txl-row"><div class="grow"><div class="t1">Mode</div><div class="t2">Button 1 (MODE) under the screen switches it too; each mode keeps its own data fields</div></div>' + seg('mode', modeOf(this.s.mode).id, MODES.map(function (m) { return [m.id, m.name]; })) + '</div>' : '') +
        (MODES.some(function (m) { return capsOf(m.id).split; }) || PLUS() ? '<div class="txl-row"><div class="grow"><div class="t1">Split screen</div><div class="t2">' + (PLUS() ? 'Map on the left; on the right: video, music or (Track) gauges in Adventure and Track, the music player in every mode' : 'Adventure and Track: map on the left, video, music or (Track) gauges on the right. Chase and Rally use the music bar instead') + '</div></div>' + seg('split', this.s.split ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' : '') +
        ('<div class="txl-row"><div class="grow"><div class="t1">Video screen</div><div class="t2">YouTube links and your WebM videos (settings/TreadXLGPS/videos)</div></div>' + seg('videoScreen', this.s.videoScreen ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>') +
        (function (self) {
          var pc = self.pipCfg(), CORNERS = [['tl', 'TOP L'], ['tr', 'TOP R'], ['bl', 'BOT L'], ['br', 'BOT R']], lk = pc.open ? '' : ' <span class="lk">' + G.lock + '</span>';
          return '<div class="txl-row"><div class="grow"><div class="t1">Map over the video' + lk + '</div><div class="t2">The video fills the screen; the map sits small in this corner (tap it for the full map)</div></div>' + seg('vidPip', pc.v, CORNERS) + '</div>' +
            (PLUS() ? '<div class="txl-row"><div class="grow"><div class="t1">Music player' + lk + '</div><div class="t2">A music bar over the map (tap it for the full player), or the full / split screen</div></div>' + seg('musStyle', pc.ms, [['pip', 'BAR'], ['split', 'SCREEN']]) + '</div>' +
              (pc.ms === 'pip' ? '<div class="txl-row"><div class="grow"><div class="t1">Music bar' + lk + '</div><div class="t2">Along the bottom or the top of the map, or down its left or right side</div></div>' + seg('mbarPos', pc.open ? self.s.mbarPos : 'bottom', [['bottom', 'BOTTOM'], ['top', 'TOP'], ['left', 'LEFT'], ['right', 'RIGHT']]) + '</div>' : '')
            : '<div class="txl-row"><div class="grow"><div class="t1">Music player' + lk + '</div><div class="t2">A small card over the map, or the full / split screen</div></div>' + seg('musStyle', pc.ms, [['pip', 'CARD'], ['split', 'SCREEN']]) + '</div>' +
              (pc.ms === 'pip' ? '<div class="txl-row"><div class="grow"><div class="t1">Music card corner' + lk + '</div></div>' + seg('musPip', pc.m, CORNERS) + '</div>' : '')) +
            (pc.open ? '' : '<div class="txl-note">These are set on a Baja75 server or with the unit unlocked (a personal-use license from Baja75 on Patreon).</div>');
        })(this) +
        '<div class="txl-row"><div class="grow"><div class="t1">Music player screen</div><div class="t2">Your music (settings/TreadXLGPS/music)</div></div>' + seg('musicScreen', this.s.musicScreen ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        (isCommon() || ONYX ? '' : '<div class="txl-row"><div class="grow"><div class="t1">YouTube page on the web</div><div class="t2">Plays YouTube inside ' + esc(WEB_PAGE) + ' so YouTube gets a web address (no Error 153). Off = skip it</div></div>' + seg('videoWeb', this.s.videoWeb !== false ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Your own YouTube page</div><div class="t2">The address of a copy of yt.html on your own website (tried first). Empty = not used</div></div></div>' +
        '<div class="txl-note txl-yt-broken"><b>YouTube access is currently broken.</b> A fix is being worked on; there is no expected completion time yet. Your own videos (WebM) still play.</div>' +
        '<div class="txl-row"><input class="txl-input" type="text" data-in="videoPage" maxlength="300" placeholder="https://your-site/yt.html" value="' + esc(this.s.videoPage || '') + '">' + kbd('videoPage') + '</div>' +
        (function (bl) {
          var names = [];
          if (bl.own) names.push('your page'); if (bl.web) names.push('the web page'); if (bl.local) names.push('this computer\u2019s page');
          return names.length ? '<div class="txl-row"><div class="grow"><div class="t1">Blocked by BeamNG\u2019s screen</div><div class="t2">' + esc(names.join(', ')) + ': skipped when you play a video</div></div>' + btn('videoUnblock', 'Try again') + '</div>' : '';
        })(this.s.videoBlocked || {}) +
        '<div class="txl-row"><div class="grow"><div class="t1">Which sites can the GPS screen open?</div><div class="t2">' + esc(this.siteCheckText()) + '</div></div>' + btn('siteCheck', this.sites && this.sites.running ? 'Checking\u2026' : 'Check sites') + '</div>') +
        (MODES.some(function (m) { return capsOf(m.id).gauges; }) ? '<div class="txl-row"><div class="grow"><div class="t1">Track gauges screen</div><div class="t2">Track: rev counter, gear, speed, pedals, G-force, temperatures, fuel, boost and battery</div></div>' + seg('gaugesScreen', this.s.gaugesScreen ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' : '') +
        '<div class="txl-row"><div class="grow"><div class="t1">Music bar</div><div class="t2">Chase and Rally: a small player under the waypoint list (tap it for the full player)</div></div>' + seg('musicBar', this.s.musicBar ? 1 : 0, [[1, 'SHOW'], [0, 'HIDE']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Media volume</div></div><input class="txl-range" type="range" min="0" max="1" step="0.05" data-in="mediaVol" value="' + this.s.mediaVol + '"></div>' +
        '<div class="txl-note">' + (EDITION === 'chase' ? '<b>Chase Edition</b>: the chase navigator with pits, start / finish, VCPs and speed zones, and the music bar.'
          : EDITION === 'rally' ? '<b>Rally Edition</b>: full co-driver calls, rally pacenotes and the music bar.'
          : EDITION === 'track' ? '<b>Track Edition</b>: Track mode with the gauge panel and telemetry, split screen and lap racing.'
          : ONYX ? '<b>Onyx Edition</b>: road and overland exploration. Record up to 3 routes, mark hazards and notes, follow a route on the map, music and your own videos.'
          : FREE ? '<b>Free Edition</b>: Adventure mode with the map, music, course import, racing, Times and 1 course of your own. Everything else opens on a Baja75 server or with a product key (Baja75 on Patreon).'
          : COMMON ? '<b>Common Edition</b>: all four modes with the map, music, course import, race times and history, and 2 courses of your own (record in single player or on a Baja75 server). No video, marking or Chase Map.'
          : '<b>Chase</b>: the navigator, with co-driver calls as directions only (sharp / half left, right, straight, cautions, extras) and the music bar. <b>Adventure</b>: everything, with split screen. <b>Rally</b>: full co-driver calls and the music bar. <b>Track</b> (was Tuner): the vehicle\u2019s gauges, with split screen.') + '</div>' +
        (EDITION !== 'full' ? '<div class="txl-note">' + (FULL ? '<b>On a Baja75 server</b>: every feature of every edition is open here.' : 'On a Baja75 server every edition has every feature.') + '</div>' : '') +
        '<div class="txl-note">Button 2 (DISPLAY) under the screen switches between the map, video, music and (Track) the gauges. All five buttons and the media keys (volume up / down, mute, play / pause, next, previous, split screen) can be bound in Options \u203a Controls: search <b>Baja75</b>.</div></div>' +
        '<div class="txl-sec"><h3>Course line</h3>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Colour</div></div><div class="txl-swatches">' + COURSE_COLORS.map(function (c) { return '<button class="txl-swatch' + (self.s.courseColor === c ? ' on' : '') + '" style="background:' + c + '" data-act="set" data-k="courseColor" data-v="' + c + '"></button>'; }).join('') + '</div></div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Highlight sharp turns</div><div class="t2">Yellow / orange / red by how tight the turn is</div></div>' + seg('sharpTurns', this.s.sharpTurns ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div></div>' +
        '<div class="txl-sec"><h3>Screen</h3>' +
        (THEMES.length > 1 && !ONYX ? '<div class="txl-row"><div class="grow"><div class="t1">Theme</div></div>' +
          seg('themeNext', this.s.themeNext || this.theme().id, THEMES.map(function (t) { return [t.id, t.name.toUpperCase()]; })) + '</div>' +
          '<div class="txl-note txl-themenote">' + (this.s.themeNext && this.s.themeNext !== this.theme().id ? '<b class="txl-themewait">' + esc(themeOf(this.s.themeNext).name) + ' is set: press the power button to restart the unit and apply it.</b>' : 'The case, colours and home screen. A new theme goes on when the unit restarts (power button).') + '</div>' : '') +
        '<div class="txl-row"><div class="grow"><div class="t1">On the vehicle\u2019s screen</div><div class="t2">Shows the unit on the vehicle\u2019s own navigation screen (cars that have one). Click the dash or press <i>Pop up</i> (Options \u203a Controls) to open it here</div></div>' + seg('dash', this.s.dash ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Device bezel</div><div class="t2">Off = screen only, for small HUD space</div></div>' + seg('bezel', this.s.bezel ? 1 : 0, [[1, 'ON'], [0, 'OFF']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Waypoint list</div></div>' + seg('deck', this.s.deck ? 1 : 0, [[1, 'SHOW'], [0, 'MAP ONLY']]) + '</div>' +
        '<div class="txl-row"><div class="grow"><div class="t1">Trip &amp; max speed</div></div>' + btn('resetTrip', 'Reset') + '</div></div>' +
        (ONYX ? '' : this.licenseHtml()) +
        '<div class="txl-sec"><h3>About</h3><div class="txl-row"><div class="grow"><div class="t1">Baja75 Navigation Unit v' + VERSION + (EDITION_NAME ? ' \u00b7 ' + EDITION_NAME : '') + '</div><div class="t2">' + esc(about) + '</div></div></div></div>';
    }
    return head('Menu') + tabHtml + '<div class="txl-sheetbody">' + body + '</div>';
  };

  // ---------------------------------------------------------------- modes, the five buttons, split screen, video + music
  // C-A-R-T: Chase, Adventure, Rally, Track (id 'tuner': the old name, kept so saved settings carry over)
  var ALL_MODES = [
    { id: 'chase', name: 'CHASE', color: '#ff6a13' }, { id: 'adventure', name: 'ADVENTURE', color: '#22b05a' },
    { id: 'rally', name: 'RALLY', color: '#e8382b' }, { id: 'tuner', name: 'TRACK', color: '#1d8cff' } // Tuner was renamed Track (v2.7.04)
  ];
  // what each mode offers: split screen (Adventure, Tuner), the CarPlay-style music bar (Chase, Rally), the gauge panel
  // (Tuner); Chase reads pacenotes as directions only (Lua: setPacenoteOptions style 'chase')
  var MODE_CAPS = {
    chase: { split: false, musicBar: true, calls: 'chase' }, adventure: { split: true },
    rally: { split: false, musicBar: true }, tuner: { split: true, gauges: true }
  };
  // each mode's own data fields (with a course loaded / free drive); Chase keeps the original sets
  var MODE_FIELDS = {
    rally: ['raceMile', 'toNext', 'toFinish'], rallyFree: ['speed', 'heading', 'trip'],
    tuner: ['rpm', 'gear', 'waterTemp'], tunerFree: ['rpm', 'gear', 'oilTemp'],
    adventure: ['heading', 'elevation', 'trip'], adventureFree: ['heading', 'elevation', 'trip']
  };
  // the Chase and Rally Editions have just their own mode
  var MODES = ALL_MODES;
  // the single-mode editions: Chase, Rally, Track (mode id 'tuner')
  function refreshModes() {
    var one = { chase: 'chase', rally: 'rally', track: 'tuner', free: 'adventure' }[ED()];
    MODES = ONYX ? [{ id: 'adventure', name: 'OVERLAND', color: '#cfd4da' }] : one ? ALL_MODES.filter(function (m) { return m.id === one; }) : ALL_MODES;
    TreadXLApp.MODES = MODES;
  }
  refreshModes();
  function modeOf(id) { for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i]; return MODES[0]; }
  function capsOf(id) { return MODE_CAPS[modeOf(id).id] || {}; }
  TreadXLApp.MODES = MODES;
  TreadXLApp.MODE_CAPS = MODE_CAPS;
  // a YouTube link -> { id, list, start } (watch, youtu.be, shorts, live, embed, music.youtube) or null
  function parseYouTube(url) {
    var str = String(url || '').trim();
    var m = str.match(/^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\/(.*)$/i);
    if (!m) return /^[\w-]{11}$/.test(str) ? { id: str, start: 0 } : null;
    var rest = m[2], q = {}, qi = rest.indexOf('?');
    if (qi >= 0) rest.slice(qi + 1).split(/[&#]/).forEach(function (kv) { var p = kv.split('='); if (p[0]) { try { q[p[0]] = decodeURIComponent(p[1] || ''); } catch (_) { q[p[0]] = p[1] || ''; } } });
    var path = (qi >= 0 ? rest.slice(0, qi) : rest).split('#')[0];
    var pm = path.match(/^(?:shorts|live|embed|v)\/([\w-]{11})/) || (/^youtu\.be$/i.test(m[1]) ? path.match(/^([\w-]{11})/) : null);
    var id = pm ? pm[1] : q.v && /^[\w-]{11}$/.test(q.v) ? q.v : null;
    var list = q.list && /^[\w-]+$/.test(q.list) ? q.list : null;
    if (!id && !list) return null;
    var t = q.t || q.start, start = 0;
    if (t) { var tm = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/); if (tm) start = (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0); }
    return { id: id, list: list, start: start };
  }
  TreadXLApp.parseYouTube = parseYouTube;
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60;
    return (h ? h + ':' + ('0' + mm).slice(-2) : mm) + ':' + ('0' + ss).slice(-2);
  }
  // a file in the user folder as the UI loads it: every path part encoded
  function mediaUrl(path) { return String(path || '').split('/').map(function (p, i) { return i === 0 ? p : encodeURIComponent(p); }).join('/'); }
  var YT_ERRORS = {
    2: 'that link has a bad video id', 5: 'the video can\u2019t play in this player', 100: 'the video was removed or is private',
    101: 'its owner doesn\u2019t allow other players', 150: 'its owner doesn\u2019t allow other players', 153: 'YouTube wants a web page address and the game\u2019s screen has none'
  };

  P.mediaInit = function () {
    var self = this;
    this.media = { music: [], videos: [], paths: {}, real: {} };
    this.elx = null;      // the vehicle's electrics (Tuner mode)
    this.mus = { i: -1, bad: 0 };
    this.vid = null;      // { kind: 'yt' | 'file', ... }
    this.yts = { port: 0, asked: false, waiting: null, err: '' }; // the YouTube page the game serves (Error 153 fix)
    this.videoUrl = '';
    try { this.audio = new window.Audio(); if (this.isDash) this.audio.muted = true; } catch (_) { this.audio = null; }
    if (this.audio && typeof this.audio.addEventListener === 'function') {
      this.audio.addEventListener('ended', function () { self.musicEnded(); });
      this.audio.addEventListener('error', function () { if (self.audio.getAttribute('src')) self.musicError(); });
      this.audio.addEventListener('playing', function () { self.mus.bad = 0; });
    }
    this.onMsg = function (ev) { self.ytMessage(ev); };
    window.addEventListener('message', this.onMsg);
    // what the game's screen allows in frames (its Content Security Policy), and what it blocks: decides the YouTube route
    this.cspInfo = readCsp();
    this.onCsp = function (e) { self.cspViolation(e); };
    try { document.addEventListener('securitypolicyviolation', this.onCsp); } catch (_) { }
    this.mediaTimer = setInterval(function () { self.mediaTick(); }, 250);
    var q = function (sel) { return self.el.media.querySelector(sel); };
    this.m = {
      title: q('.md-title'), sub: q('.md-sub'), swap: q('.md-btn.swap'), split: q('.md-btn.split'),
      url: q('[data-in="videoUrl"]'), stage: q('.mv-stage'), msg: q('.mv-msg'), vlist: q('.mv-list'),
      vctl: q('.mv-ctl'), now: q('.mm-now'), mctl: q('.mm-ctl'), opts: q('.mm-opts'), mlist: q('.mm-list'),
      vfull: q('.mc-b.vfull'), vsplit: q('.mc-b.vsplit')
    };
    // full screen video: the controls hide after 3 s and come back when the mouse moves or the screen is tapped
    this.onWake = function () { if (self.vfull) self.wakeVideoCtl(); };
    this.el.media.addEventListener('mousemove', this.onWake);
    this.el.media.addEventListener('mousedown', this.onWake);
    [].forEach.call(this.el.media.querySelectorAll('.mc-b.mute'), function (b) { b.innerHTML = G.speaker; });
    this.renderMedia();
  };
  // the media screens this mode offers, in DISPLAY order
  P.screens = function () {
    var s = this.s, l = [];
    if (s.videoScreen && !isFree()) l.push('video');
    if (s.musicScreen) l.push('music');
    if (capsOf(s.mode).gauges && s.gaugesScreen) l.push('gauges');
    return l;
  };
  // split screen is on and this mode has it (Adventure, Tuner)
  P.splitOn = function () {
    if (isCommon()) return false; // the Common Edition off the servers: video full screen with the map in the corner
    if (this.panelKind && this.s.display === 'music' && this.pipCfg().ms === 'pip') return false; // music as a corner card / bar
    if (!this.s.split) return false;
    if (capsOf(this.s.mode).split) return true;
    return PLUS() && (this.s.display === 'music' || (this.s.display === 'gps' && this.s.lastMedia === 'music' && this.s.musicScreen)); // v3.4: music split in Chase / Rally too
  };
  // picture-in-picture: the map's corner over the video, music as a corner card or the full / split screen.
  // Choosing them needs a Baja75 server or the unit unlocked; otherwise bottom right, music as a card.
  P.pipCfg = function () {
    var ok = this.allowed('pip'), s = this.s, c = function (v) { return /^(tl|tr|bl|br)$/.test(v) ? v : 'br'; };
    return ok ? { v: c(s.vidPip), ms: s.musStyle === 'pip' ? 'pip' : 'split', m: c(s.musPip), open: true } : { v: 'br', ms: 'pip', m: 'br', open: false };
  };
  // which screen the media panel shows: 'video' | 'music' | 'gauges' | null (none: just the map)
  P.panelKind = function () {
    var s = this.s, l = this.screens();
    if (s.display !== 'gps' && l.indexOf(s.display) >= 0) return s.display;
    if (this.splitOn()) return l.indexOf(s.lastMedia) >= 0 ? s.lastMedia : l[0] || null;
    return null;
  };
  // button 1: Chase -> Adventure -> Rally -> Track
  P.cycleMode = function () {
    if (MODES.length < 2) { this.toast(EDITION_NAME ? EDITION_NAME.toUpperCase() + ': ' + MODES[0].name + ' MODE ONLY' : MODES[0].name + ' MODE', 'info'); return; }
    if (!this.guard('modes')) return;
    var cur = modeOf(this.s.mode).id, i = 0;
    for (var k = 0; k < MODES.length; k++) if (MODES[k].id === cur) i = k;
    this.setMode(MODES[(i + 1) % MODES.length].id);
  };
  P.setMode = function (id) {
    var md = modeOf(id), c = capsOf(md.id), s = this.s;
    s.mode = md.id;
    // a screen this mode doesn't have goes back to the map; Tuner's split side starts on the gauges
    if (s.split && !c.split && s.display !== 'gps' && !(PLUS() && s.display === 'music')) s.display = 'gps'; // (v3.4: music keeps its split side)
    if (s.display === 'gauges' && !c.gauges) s.display = 'gps';
    if (c.gauges && s.split && s.gaugesScreen && s.display === 'gps') s.lastMedia = 'gauges';
    this.save(); this.applySettings(); this.renderMedia(); this.renderAll();
    this.pushPacenoteOptions(); // Chase: direction-only co-driver calls
    if (this.sheet === 'menu') this.renderSheet();
    this.toast(md.name + ' MODE', 'info');
  };
  // button 2: map -> video -> music (the screens switched on in Display); in split screen it swaps the right side
  P.cycleDisplay = function () {
    var s = this.s, l = this.screens();
    this.mbarBig = false;
    if (!l.length) { this.toast('Turn on the video or music screen in MENU \u203a Display', 'info'); return; }
    if (this.splitOn()) {
      var cur = this.panelKind();
      s.display = l[(l.indexOf(cur) + 1) % l.length];
    } else {
      var list = ['gps'].concat(l);
      s.display = list[(list.indexOf(s.display) + 1) % list.length] || 'gps';
    }
    if (s.display !== 'gps') s.lastMedia = s.display;
    this.save(); this.applySettings(); this.renderMedia(); this.renderAll();
    this.toast(s.display === 'video' ? 'VIDEO' : s.display === 'music' ? 'MUSIC' : s.display === 'gauges' ? 'GAUGES' : 'MAP', 'info');
  };
  P.hwButton = function (n) {
    if (this.root.getAttribute('data-bsod') === '1') return;
    var b = this.root.querySelector('.txl-hwb[data-v="' + n + '"]');
    if (b) { b.classList.add('pressed'); setTimeout(function () { b.classList.remove('pressed'); }, 160); }
    if (isFree() && (n === 1 || n === 2)) this.nudge();
    if (n === 1 && ONYX) { this.showHome(!this.home); return; }
    if (n === 3 && !ONYX) { this.showHome(!this.home); return; } // v3.1.9: HOME
    if (this.home && (n === 2 || (n === 1 && !ONYX))) this.showHome(false); // MODE / DISPLAY leave the home screen
    if (n === 1) { if (!isFree()) this.cycleMode(); }
    else if (n === 2) this.cycleDisplay();
    // buttons 3-5: built for a later update, nothing yet
  };
  P.activeMedia = function () {
    var pk = this.panelKind();
    if (pk) return pk;
    if (this.audio && !this.audio.paused) return 'music';
    return this.vid ? 'video' : 'music';
  };
  // the media keys (Options > Controls)
  P.mediaKey = function (what) {
    var target = this.activeMedia();
    switch (what) {
      case 'volUp': this.setVolume(this.s.mediaVol + 0.1); this.s.mediaMuted = false; this.applyVolume(); this.save(); this.toast('Volume ' + Math.round(this.s.mediaVol * 100) + ' %', 'info'); break;
      case 'volDown': this.setVolume(this.s.mediaVol - 0.1); this.save(); this.toast('Volume ' + Math.round(this.s.mediaVol * 100) + ' %', 'info'); break;
      case 'mute': this.s.mediaMuted = !this.s.mediaMuted; this.applyVolume(); this.save(); this.toast(this.s.mediaMuted ? 'Muted' : 'Sound on', 'info'); break;
      case 'playPause': if (target === 'video') this.videoToggle(); else this.musicToggle(); break;
      case 'next': if (target === 'video') this.videoSeekBy(10); else this.musicNext(1); break;
      case 'prev': if (target === 'video') this.videoSeekBy(-10); else this.musicPrev(); break;
      case 'split': this.act('mediaSplit'); break;
      case 'full': this.setVideoFull(!this.vfull); break;
    }
    this.mediaTick(true);
  };
  P.setVolume = function (v) {
    this.s.mediaVol = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100;
    this.applyVolume();
  };
  P.applyVolume = function () {
    var vol = Math.max(0, Math.min(1, Number(this.s.mediaVol))), mute = !!this.s.mediaMuted, v = this.vid;
    if (this.audio) { this.audio.volume = vol; this.audio.muted = mute; }
    if (v && v.kind === 'file') { v.el.volume = vol; v.el.muted = mute; }
    if (v && v.kind === 'yt') { this.ytPost('setVolume', [Math.round(vol * 100)]); this.ytPost(mute ? 'mute' : 'unMute'); }
  };

  // the game page's Content Security Policy (a <meta> tag), and the sources it lets frames load from
  function readCsp() {
    var out = { policy: '', frames: null };
    try {
      var metas = document.querySelectorAll('meta[http-equiv]');
      for (var i = 0; i < metas.length; i++) if (/content-security-policy/i.test(metas[i].getAttribute('http-equiv'))) out.policy += (out.policy ? '; ' : '') + (metas[i].getAttribute('content') || '');
    } catch (_) { }
    out.frames = cspSources(out.policy, ['frame-src', 'child-src', 'default-src']);
    return out;
  }
  function cspSources(policy, order) {
    var dirs = {};
    String(policy || '').split(';').forEach(function (d) { var t = d.trim().split(/\s+/); if (t[0]) dirs[t[0].toLowerCase()] = t.slice(1); });
    for (var i = 0; i < order.length; i++) if (dirs[order[i]]) return dirs[order[i]];
    return null; // no rule: anything goes
  }
  // can a frame load this address under these CSP sources? (scheme sources, hosts with *. wildcards, ports)
  function cspAllows(src, url) {
    if (!src) return true;
    var m = String(url || '').match(/^(https?):\/\/([^\/:?#]+)(?::(\d+))?/i);
    if (!m) return false;
    var scheme = m[1].toLowerCase(), host = m[2].toLowerCase(), port = m[3] || '';
    for (var i = 0; i < src.length; i++) {
      var x = src[i].toLowerCase();
      if (x.charAt(0) === "'") continue; // 'self', 'none', nonces
      if (x === '*') return true;
      if (x === scheme + ':' || (x === 'http:' && scheme === 'https')) return true;
      var sm = x.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^\/:]+)(?::(\d+|\*))?/);
      if (!sm || /:$/.test(x)) continue;
      if (sm[1] && sm[1] !== scheme && !(sm[1] === 'http' && scheme === 'https')) continue;
      var hp = sm[2];
      var hostOk = hp === host || (hp.indexOf('*.') === 0 && host.length > hp.length - 1 && host.slice(-(hp.length - 1)) === hp.slice(1));
      if (!hostOk) continue;
      if (sm[3] && sm[3] !== '*' && sm[3] !== port) continue;
      if (!sm[3] && port) continue;
      return true;
    }
    return false;
  }
  TreadXLApp.cspAllows = cspAllows;
  P.cspViolation = function (e) {
    var uri = String((e && e.blockedURI) || ''), dir = String((e && (e.effectiveDirective || e.violatedDirective)) || '');
    if (!/youtube|localhost|127\.0\.0\.1|yt\.html/i.test(uri)) return;
    this.cspInfo.hit = { uri: uri.slice(0, 200), dir: dir, policy: String((e && e.originalPolicy) || '').slice(0, 3000) };
    if (!this.cspInfo.policy && this.cspInfo.hit.policy) { this.cspInfo.policy = this.cspInfo.hit.policy; this.cspInfo.frames = cspSources(this.cspInfo.policy, ['frame-src', 'child-src', 'default-src']); }
    this.uiLog('CSP blocked ' + uri + ' (' + dir + '). Policy: ' + this.cspInfo.hit.policy);
  };
  P.uiLog = function (msg) { this.call('uiLog', luaStr(String(msg || '').slice(0, 3500))); };

  // ---- video: YouTube through its embed player, or your own WebM files
  // YouTube's player answers "Error 153" on BeamNG's screens: they are local:// pages and send no web address. So the
  // player is put inside a small page that has one, tried in this order until one works:
  //   1. your own page address (MENU > Display), 2. the GPS's page on the web (WEB_PAGE, web/yt.html in the mod),
  //   3. the same page served by the game on this computer (http://localhost:37575/yt.html, then 127.0.0.1),
  //   4. YouTube's player straight in (Error 153 on most game versions; WEB opens the link in your browser).
  // A page that loads but doesn't say "ready" within 1.2 s, or nothing at all in 5 s, moves on to the next one.
  var WEB_PAGE = 'https://leshii413.github.io/yt.html';
  TreadXLApp.WEB_PAGE = WEB_PAGE;
  function pageAddress(u) {
    u = String(u || '').trim();
    if (isYouTubeAddress(u)) return ''; // a video link, not a page to put the player in (YouTube won't be framed)
    return /^https?:\/\/[\w.-]+(:\d+)?\/[^\s"'<>]*$/i.test(u) && u.length <= 300 ? u : '';
  }
  function isYouTubeAddress(u) { return /^(https?:\/\/)?([\w-]+\.)*(youtube\.com|youtube-nocookie\.com|youtu\.be)(\/|$|:)/i.test(String(u || '').trim()); }
  TreadXLApp.pageAddress = pageAddress;
  P.videoPlay = function (url) {
    url = String(url || '').trim();
    var yt = parseYouTube(url);
    if (!yt) {
      if (/^https?:\/\//i.test(url)) this.vidMessage('That isn\u2019t a YouTube link. Press WEB to open it in your browser (Steam overlay).', true);
      else this.toast('Paste a YouTube link first', 'warning');
      return;
    }
    if (this.panelKind() !== 'video') { this.s.display = 'video'; this.s.lastMedia = 'video'; this.save(); this.applySettings(); this.renderMedia(); this.renderAll(); }
    this.videoStop();
    this.addRecent(url);
    var ys = this.yts;
    if (!ys.asked) { ys.asked = true; ys.err = ''; ys.askedAt = Date.now(); this.call('videoServer'); } // the page on this computer, for later
    ys.tried = [];
    this.videoOpen(url, 0);
  };
  // the game's answer: { port } or { error }
  P.videoServerReady = function (d) {
    var ys = this.yts;
    if (!ys) return;
    ys.port = d && Number(d.port) > 0 && Number(d.port) < 65536 ? Math.floor(Number(d.port)) : 0;
    ys.err = ys.port ? '' : String((d && d.error) || 'it couldn\u2019t start').slice(0, 120);
  };
  // ---- which sites BeamNG's screen lets a frame open (its navigation filter, "OnBeforeNavigation DENIED" in its log).
  // One hidden frame per site, 6 at a time: a frame that loads anything (a page or an error page) = the site opens;
  // one still blank after 6 s with nothing loaded = blocked. MENU > Display > Check sites; the result also goes to beamng.log.
  var SITE_CHECK = ['https://www.youtube.com/', 'https://www.youtube-nocookie.com/', 'https://m.youtube.com/', 'https://music.youtube.com/',
    'https://leshii413.github.io/', 'https://about.gitlab.com/', 'https://pages.cloudflare.com/', 'https://www.netlify.com/', 'https://vercel.com/', 'https://firebase.google.com/',
    'https://neocities.org/', 'https://www.blogger.com/', 'https://sites.google.com/', 'https://raw.githack.com/', 'https://cdn.jsdelivr.net/', 'https://unpkg.com/',
    'https://codepen.io/', 'https://jsfiddle.net/', 'https://glitch.com/', 'https://surge.sh/',
    'https://www.beamng.com/', 'https://beamng.com/', 'https://documentation.beamng.com/', 'https://wiki.beamng.com/', 'https://api.beamng.com/',
    'https://beammp.com/', 'https://forum.beammp.com/', 'https://get-rla-rr.com/', 'https://www.patreon.com/', 'https://discord.com/',
    'https://steamcommunity.com/', 'https://store.steampowered.com/', 'https://imgur.com/', 'https://player.vimeo.com/', 'https://player.twitch.tv/',
    'https://www.dailymotion.com/', 'https://streamable.com/', 'https://www.google.com/'];
  TreadXLApp.SITE_CHECK = SITE_CHECK;
  P.siteCheck = function (list, cb) {
    if (this.sites && this.sites.running) return;
    var self = this, todo = (list || SITE_CHECK).slice(), res = [], live = 0, box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;width:4px;height:4px;overflow:hidden;opacity:0;pointer-events:none';
    this.root.appendChild(box);
    this.sites = { running: true, done: res, total: todo.length };
    var host = function (u) { return String(u).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); };
    var next = function () {
      while (live < 6 && todo.length) {
        live++;
        (function (url) {
          var f = document.createElement('iframe');
          f.src = url;
          box.appendChild(f);
          setTimeout(function () {
            // where the frame ended up: still our blank page = the game refused it (a load event alone can be the blank page's);
            // another site's page can't be read (it throws) = it opened
            var opened;
            try { opened = !/^about:/i.test(String(f.contentWindow.location.href)); } catch (_) { opened = true; }
            res.push({ host: host(url), ok: opened });
            try { box.removeChild(f); } catch (_) { }
            live--;
            if (!self.destroyed && self.sheet === 'menu') self.renderSheet();
            if (todo.length) next();
            else if (!live) finish();
          }, 6000);
        })(todo.shift());
      }
    };
    var finish = function () {
      try { self.root.removeChild(box); } catch (_) { }
      self.sites.running = false;
      self.uiLog('site check: ' + self.siteCheckText());
      if (!self.destroyed && self.sheet === 'menu') self.renderSheet();
      if (cb) cb(res);
    };
    this.toast('Checking ' + todo.length + ' sites (about ' + Math.ceil(todo.length / 6) * 6 + ' s)', 'info');
    next();
  };
  P.siteCheckText = function () {
    var st = this.sites;
    if (!st) return 'Tests which sites BeamNG lets its screen show (YouTube only works through one that it allows). Not checked yet';
    var ok = st.done.filter(function (r) { return r.ok; }).map(function (r) { return r.host; });
    var no = st.done.filter(function (r) { return !r.ok; }).map(function (r) { return r.host; });
    return (st.running ? 'Checking ' + st.done.length + ' of ' + st.total + '\u2026 ' : '') + 'Opens: ' + (ok.join(', ') || 'none') + ' \u00b7 Blocked: ' + (no.join(', ') || 'none');
  };
  // the pages to try, in order
  // pages BeamNG's screen refused to open (no load at all) are remembered and skipped; MENU > Display > TRY AGAIN forgets
  P.ytRoutes = function () {
    var s = this.s, out = [], own = pageAddress(s.videoPage), bl = s.videoBlocked || {};
    if (own && bl.own !== own) out.push({ kind: 'own', page: own });
    if (s.videoWeb !== false && own !== WEB_PAGE && !bl.web) out.push({ kind: 'web', page: WEB_PAGE });
    if (!bl.local) out.push({ kind: 'local', host: 'localhost' }, { kind: 'local', host: '127.0.0.1' });
    return out;
  };
  P.ytBlocked = function (kind) {
    var bl = this.s.videoBlocked || (this.s.videoBlocked = {});
    if (kind === 'own') bl.own = pageAddress(this.s.videoPage); else bl[kind] = 1;
    this.save();
  };
  // step = which page of ytRoutes(); past the end = YouTube's player straight in. alt: www.youtube.com instead of -nocookie
  P.videoOpen = function (url, step, alt) {
    var yt = parseYouTube(url);
    if (!yt) return;
    var ys = this.yts, ci = this.cspInfo || {}, routes = this.ytRoutes(), self = this, route = null, src = '';
    ys.tried = ys.tried || [];
    clearTimeout(ys.waitTimer);
    var q = '?v=' + (yt.id || '') + (yt.list ? '&list=' + encodeURIComponent(yt.list) : '') + (yt.start ? '&start=' + yt.start : '') + (alt ? '&yt=1' : '') + '&w=' + VERSION;
    while (step < routes.length) {
      route = routes[step];
      if (route.kind === 'local') {
        if (!ys.port && !ys.err && Date.now() - (ys.askedAt || 0) < 2500) { // the game hasn't answered yet: wait a moment
          this.vidMessage('Starting the video player\u2026');
          ys.waitTimer = setTimeout(function () { self.videoOpen(url, step, alt); }, 300);
          return;
        }
        src = ys.port ? 'http://' + route.host + ':' + ys.port + '/yt.html' + q : '';
        if (!src) { if (!alt) ys.tried.push({ route: route, why: 'nopage' }); step++; continue; }
      } else src = route.page + q;
      if (!cspAllows(ci.frames, src)) { if (!alt) ys.tried.push({ route: route, why: 'csp' }); step++; continue; } // the game's rules forbid it: don't wait
      break;
    }
    var direct = step >= routes.length;
    if (direct) {
      route = { kind: 'direct' };
      var origin = /^https?:$/i.test(window.location.protocol) ? window.location.origin : '';
      src = 'https://www.youtube-nocookie.com/embed/' + (yt.id || 'videoseries') + '?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1' +
        (yt.list ? '&list=' + encodeURIComponent(yt.list) : '') + (yt.start ? '&start=' + yt.start : '') + (origin ? '&origin=' + encodeURIComponent(origin) : '');
    }
    this.videoStop();
    var f = document.createElement('iframe');
    f.className = 'mv-frame';
    f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('frameborder', '0');
    f.setAttribute('allowfullscreen', '');
    var now = Date.now();
    var v = this.vid = { kind: 'yt', url: url, frame: f, t0: now, t1: direct ? now : 0, step: step, route: route.kind, page: direct ? '' : src, alt: !!alt,
      pageOk: direct, alive: false, cur: yt.start || 0, dur: 0, state: -1 };
    f.addEventListener('load', function () { if (self.vid === v && !v.pageOk) v.loadedAt = Date.now(); });
    f.src = src;
    this.m.stage.appendChild(f);
    v.listen = setInterval(function () { self.ytListen(); }, 250);
    this.vidMessage('');
    this.renderVideoList();
  };
  // why no page with a web address worked, in a few words (beamng.log has the details)
  P.ytWhy = function () {
    var ys = this.yts, ci = this.cspInfo || {}, tried = ys.tried || [];
    var name = function (k) { return k === 'own' ? 'your page' : k === 'web' ? 'the web page' : 'this computer\u2019s page'; };
    var csp = tried.filter(function (t) { return t.why === 'csp'; }), y153 = tried.filter(function (t) { return t.why === '153'; });
    if (csp.length && csp.length === tried.length)
      return 'BeamNG\u2019s screen only allows frames from ' + (ci.frames && ci.frames.length ? ci.frames.slice(0, 8).join(' ') : 'its own list') + ', so the video pages can\u2019t open';
    if (y153.length) return 'YouTube refused ' + y153.map(function (t) { return name(t.route.kind); }).join(' and ') + ' too';
    var bl = this.s.videoBlocked || {};
    if (!tried.length && (bl.web || bl.local)) return 'BeamNG\u2019s screen only opens YouTube\u2019s own pages and blocks the pages that would give it one (MENU \u203a Display \u203a TRY AGAIN to test them again)';
    if (tried.length && tried.every(function (t) { return t.why === 'noload' || t.why === 'csp' || t.why === 'nopage'; }))
      return 'BeamNG\u2019s screen only opens YouTube\u2019s own pages and blocked the pages that would give it one';
    if (ys.err && !tried.some(function (t) { return t.route.kind !== 'local'; })) return 'the video page: ' + ys.err;
    var seen = {}, names = [];
    tried.forEach(function (t) { var n = name(t.route.kind); if (!seen[n]) { seen[n] = 1; names.push(n); } });
    return (names.length ? names.join(', ') : 'the video pages') + ' didn\u2019t open on BeamNG\u2019s screen' + (ys.hits ? ' (the game served its page, but it couldn\u2019t talk to the GPS)' : '');
  };
  P.ytPost = function (func, args) {
    var v = this.vid;
    if (!v || v.kind !== 'yt' || !v.frame.contentWindow) return;
    try { v.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [], id: 'txl', channel: 'widget' }), '*'); } catch (_) { }
  };
  // the embed player only talks once it's asked to; no answer in 12 s = the game blocked it
  P.ytListen = function () {
    var v = this.vid;
    if (!v || v.kind !== 'yt') return;
    if (v.alive) { clearInterval(v.listen); v.listen = null; return; }
    // a page that loaded without saying "ready" (not ours, or an error page), or nothing in 5 s: try the next one
    if (!v.pageOk) {
      var now = Date.now();
      if ((v.loadedAt && now - v.loadedAt > 1200) || now - v.t0 > 5000) {
        var ys = this.yts;
        var why = v.route === 'local' && ys.hits ? 'silent' : v.loadedAt ? 'noready' : 'noload';
        if (!v.alt) ys.tried.push({ route: { kind: v.route }, why: why });
        var next = this.ytRoutes()[v.step + 1];
        // nothing loaded at all: BeamNG's screen refused it (its log says "OnBeforeNavigation DENIED"); don't wait for it again
        if (why === 'noload' && (v.route !== 'local' || v.page.indexOf('127.0.0.1') >= 0)) this.ytBlocked(v.route);
        // the list may be shorter now: go on to the same next page, wherever it is
        var after = this.ytRoutes(), step = after.length;
        if (next) for (var i = 0; i < after.length; i++) if (after[i].kind === next.kind && after[i].host === next.host) { step = i; break; }
        if (step >= after.length) this.ytReport();
        this.videoOpen(v.url, step);
      }
      return;
    }
    v.ticks = (v.ticks || 0) + 1;
    if (v.ticks % 2) return; // "listening" twice a second
    try { v.frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'txl', channel: 'widget' }), '*'); } catch (_) { }
    if (Date.now() - v.t1 > 12000 && !v.failed) {
      v.failed = true;
      this.vidMessage('No answer from YouTube: BeamNG\u2019s screen may block it in this game version. Press WEB to watch it in your browser (Steam overlay), or play WebM videos from your videos folder.', true);
    }
  };
  // once per session: what was tried and why it failed, to beamng.log ("TreadXLGPS UI:")
  P.ytReport = function () {
    if (this.ytsLogged) return;
    this.ytsLogged = true;
    var ys = this.yts;
    this.uiLog('video pages that did not work: ' + (ys.tried || []).map(function (t) { return t.route.kind + '=' + t.why; }).join(', ') +
      ' | page requests seen by Lua: ' + (ys.hits || 0) + ' | own page: ' + (pageAddress(this.s.videoPage) || '-') + ' | GPS page URL: ' + String(window.location.href).slice(0, 200) +
      ' | ' + String(navigator.userAgent).slice(0, 200) + ' | CSP: ' + ((this.cspInfo && this.cspInfo.policy) || '(no meta tag)'));
  };
  P.ytMessage = function (ev) {
    var v = this.vid;
    if (!v || v.kind !== 'yt' || ev.source !== v.frame.contentWindow) return;
    var d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'txlReady') { if (!v.pageOk) { v.pageOk = true; v.t1 = Date.now(); this.ytListen(); } return; }
    if (!v.alive) { v.alive = true; v.pageOk = true; this.vidMessage(''); this.applyVolume(); }
    if (d.event === 'onError') {
      var c = Number(d.info);
      // through a page, 153 once more with www.youtube.com, then the next page
      if (c === 153 && v.route !== 'direct') {
        if (!v.alt) { this.videoOpen(v.url, v.step, true); return; }
        this.yts.tried.push({ route: { kind: v.route }, why: '153' });
        if (v.step + 1 >= this.ytRoutes().length) this.ytReport();
        this.videoOpen(v.url, v.step + 1); return;
      }
      var why = YT_ERRORS[c] || 'it won\u2019t play here';
      if (c === 153) why += ' (' + this.ytWhy() + ')';
      this.vidMessage('YouTube error ' + c + ': ' + why + '. Press WEB to watch it in your browser.', true);
      return;
    }
    var info = d.info;
    if (d.event === 'onStateChange' && typeof info === 'number') v.state = info;
    if (info && typeof info === 'object') {
      if (isFinite(info.currentTime)) v.cur = info.currentTime;
      if (isFinite(info.duration)) v.dur = info.duration;
      if (isFinite(info.playerState)) v.state = info.playerState;
      if (info.videoData && info.videoData.title && info.videoData.title !== v.title) { v.title = String(info.videoData.title).slice(0, 120); this.titleRecent(v.url, v.title); }
    }
  };
  P.videoFile = function (i) {
    var f = arr(this.media.videos)[i];
    if (!f) return;
    this.videoStop();
    var el = document.createElement('video'), self = this;
    el.className = 'mv-frame';
    el.autoplay = true;
    el.playsInline = true;
    el.addEventListener('error', function () { self.vidMessage('This file can\u2019t play here' + (f.maybe ? ': MP4 (H.264) isn\u2019t supported, convert it to WebM' : '') + '.', true); });
    el.src = mediaUrl(f.path);
    this.m.stage.appendChild(el);
    this.vid = { kind: 'file', i: i, el: el, title: f.name };
    this.applyVolume();
    try { var pr = el.play(); if (pr && pr.catch) pr.catch(function () { }); } catch (_) { }
    this.vidMessage('');
    this.renderVideoList();
  };
  P.videoStop = function () {
    var v = this.vid;
    if (v) {
      if (v.listen) clearInterval(v.listen);
      if (v.el) { try { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } catch (_) { } }
      var node = v.frame || v.el;
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    this.vid = null;
  };
  P.vidMessage = function (txt, isErr) {
    if (!this.m) return;
    this.m.msg.textContent = txt || '';
    this.m.msg.className = 'mv-msg' + (txt ? ' show' : '') + (isErr ? ' err' : '');
  };
  P.videoState = function () {
    var v = this.vid;
    if (!v) return null;
    if (v.kind === 'file') { var e = v.el; return { cur: e.currentTime || 0, dur: isFinite(e.duration) ? e.duration : 0, playing: !e.paused }; }
    return { cur: v.cur || 0, dur: v.dur || 0, playing: v.state === 1 || v.state === 3 };
  };
  P.videoToggle = function () {
    var v = this.vid;
    if (!v) { this.act('vidGo'); return; }
    if (v.kind === 'file') { try { if (v.el.paused) v.el.play(); else v.el.pause(); } catch (_) { } }
    else { var st = this.videoState(); this.ytPost(st.playing ? 'pauseVideo' : 'playVideo'); v.state = st.playing ? 2 : 1; }
  };
  P.videoSeekTo = function (t) {
    var v = this.vid;
    if (!v) return;
    t = Math.max(0, Number(t) || 0);
    if (v.kind === 'file') { try { v.el.currentTime = t; } catch (_) { } }
    else { this.ytPost('seekTo', [t, true]); v.cur = t; }
  };
  P.videoSeekBy = function (d) { var st = this.videoState(); if (st) this.videoSeekTo(st.cur + d); };
  P.addRecent = function (url) {
    var list = arr(this.s.recentLinks).filter(function (r) { return r && r.url !== url; });
    list.unshift({ url: url });
    this.s.recentLinks = list.slice(0, 8);
    this.save();
  };
  P.titleRecent = function (url, title) {
    arr(this.s.recentLinks).forEach(function (r) { if (r && r.url === url) r.title = title; });
    this.save();
    this.renderVideoList();
  };

  // ---- music: the files in settings/TreadXLGPS/music, played by the UI browser
  P.musicPlay = function (i) {
    var list = arr(this.media.music);
    if (!list.length || !this.audio) { this.toast('No music yet: drop files in the music folder, then Rescan', 'info'); return; }
    i = ((Number(i) || 0) % list.length + list.length) % list.length;
    this.mus.i = i;
    this.audio.src = mediaUrl(list[i].path);
    this.askArt(list[i]);
    this.applyVolume();
    if (this.musicAllowed()) { this.mus.held = false; try { var pr = this.audio.play(); if (pr && pr.catch) pr.catch(function () { }); } catch (_) { } }
    else this.mus.held = true; // plays when the co-driver is done
    this.renderMusicList();
    this.mediaTick(true);
  };
  P.musicToggle = function () {
    if (!this.audio) return;
    if (this.mus.i < 0) { this.musicPlay(0); return; }
    if (this.audio.paused && this.mus.held) { this.mus.held = false; this.mediaTick(true); return; } // stop waiting for the co-driver
    if (this.audio.paused && !this.musicAllowed()) { this.mus.held = true; this.mediaTick(true); return; }
    try { if (this.audio.paused) { var pr = this.audio.play(); if (pr && pr.catch) pr.catch(function () { }); } else this.audio.pause(); } catch (_) { }
    this.mediaTick(true);
  };
  P.musicNext = function (dir) {
    var list = arr(this.media.music);
    if (!list.length) { this.musicPlay(0); return; }
    if (this.s.musicShuffle && list.length > 1) {
      var j = this.mus.i;
      while (j === this.mus.i) j = Math.floor(Math.random() * list.length);
      this.musicPlay(j);
      return;
    }
    this.musicPlay(this.mus.i + (dir || 1));
  };
  // previous: back to the start of the song first (like a car stereo)
  P.musicPrev = function () {
    if (this.audio && this.audio.currentTime > 3) { try { this.audio.currentTime = 0; } catch (_) { } return; }
    this.musicNext(-1);
  };
  P.musicEnded = function () {
    var list = arr(this.media.music);
    if (this.s.musicRepeat === 'one') { this.musicPlay(this.mus.i); return; }
    if (!this.s.musicShuffle && this.s.musicRepeat === 'off' && this.mus.i >= list.length - 1) { this.mediaTick(true); return; }
    this.musicNext(1);
  };
  P.musicError = function () {
    var t = arr(this.media.music)[this.mus.i];
    this.toast('Can\u2019t play ' + (t ? t.file : 'that file') + (t && t.maybe ? ' (M4A / AAC isn\u2019t supported)' : ''), 'warning');
    this.mus.bad = (this.mus.bad || 0) + 1;
    if (this.mus.bad < 4 && arr(this.media.music).length > 1) this.musicNext(1);
  };

  // ---- the media panel
  P.renderMedia = function () {
    if (!this.m) return;
    var pk = this.panelKind(), m = this.m;
    if (!pk) return;
    var NAMES = { video: 'VIDEO', music: 'MUSIC', gauges: 'GAUGES' }, scr = this.screens();
    m.title.textContent = NAMES[pk];
    m.swap.textContent = NAMES[scr[(scr.indexOf(pk) + 1) % scr.length]] || '';
    m.swap.style.display = scr.length > 1 ? '' : 'none';
    m.split.textContent = this.splitOn() ? 'FULL' : 'SPLIT';
    m.split.style.display = capsOf(this.s.mode).split ? '' : 'none';
    if (m.vfull) { m.vfull.innerHTML = this.vfull ? G.shrink : G.expand; m.vfull.title = this.vfull ? 'Leave full screen' : (this.splitOn() ? 'Full screen (split side)' : 'Full screen'); }
    if (m.vsplit) { m.vsplit.style.display = this.vfull && capsOf(this.s.mode).split ? '' : 'none'; m.vsplit.classList.toggle('on', this.splitOn()); }
    if (pk === 'video') this.renderVideoList(); else if (pk === 'music') this.renderMusicList(); else this.renderGauges(true);
    this.mediaTick(true);
  };
  // full screen video: the whole GPS screen, or the whole split side when split screen is on
  P.setVideoFull = function (on) {
    on = !!on;
    if (on && this.panelKind() !== 'video') {
      if (this.screens().indexOf('video') < 0) { this.toast('Turn on the video screen in MENU \u203a Display', 'info'); return; }
      this.s.display = 'video'; this.s.lastMedia = 'video'; this.save();
    }
    this.vfull = on;
    this.applySettings(); this.renderMedia(); this.renderAll();
    if (on) { this.wakeVideoCtl(); this.toast(this.splitOn() ? 'FULL SCREEN \u00b7 SPLIT SIDE' : 'FULL SCREEN', 'info'); }
    else { clearTimeout(this.vctlTimer); this.root.setAttribute('data-vctl', '1'); }
  };
  P.wakeVideoCtl = function () {
    var self = this;
    this.root.setAttribute('data-vctl', '1');
    clearTimeout(this.vctlTimer);
    this.vctlTimer = setTimeout(function () {
      if (self.destroyed || !self.vfull) return;
      var a = document.activeElement; // not while the seek or volume slider is held
      if (a && self.m && self.m.vctl && self.m.vctl.contains(a) && a.tagName === 'INPUT') { self.wakeVideoCtl(); return; }
      self.root.setAttribute('data-vctl', '0');
    }, 3000);
  };
  // button 1: MODE, or the one mode of a single-mode edition (off a Baja75 server)
  P.renderHw = function () {
    var b = this.root.querySelector('.txl-hwb[data-v="1"]');
    if (!b) return;
    var one = MODES.length < 2 && !ONYX;
    b.classList.toggle('fixed', one);
    if (ONYX) { b.title = 'Home'; var hs = b.querySelector('span'); if (hs && hs.textContent !== 'HOME') hs.textContent = 'HOME'; return; }
    var hb = this.root.querySelector('.txl-hwb[data-v="3"]'); // v3.1.9: HOME on every other edition
    if (hb && !hb.classList.contains('home')) { hb.classList.remove('off'); hb.classList.add('home'); hb.title = 'Home'; hb.querySelector('span').innerHTML = G.house + 'HOME'; }
    b.title = one ? EDITION_NAME : 'Mode: Chase / Adventure / Rally / Track';
    var sp = b.querySelector('span'), txt = one ? MODES[0].name : 'MODE';
    if (sp && sp.textContent !== txt) sp.textContent = txt;
  };
  // joined / left a Baja75 server: the features of the edition in effect
  P.editionChanged = function () {
    refreshModes();
    var cur = this.s.mode;
    if (!MODES.some(function (m) { return m.id === cur; })) this.setMode(MODES[0].id); // back to the edition's own mode
    this.icons = ICONS.map(function (i) { return i.file; }).filter(shownIcon);
    if (!shownIcon(this.s.markIcon)) this.s.markIcon = 'Tread_XL_icon_checkpoint.svg';
    if (this.screens().indexOf(this.s.display) < 0 && this.s.display !== 'gps') this.s.display = 'gps';
    this.vfull = this.vfull && this.panelKind() === 'video';
    this.applySettings(); this.renderMedia(); this.renderAll();
    if (this.sheet === 'menu' || this.sheet === 'mark') this.renderSheet();
    this.toast(FULL ? 'BAJA75 SERVER \u00b7 EVERY FEATURE OPEN' : 'OFF THE BAJA75 SERVERS \u00b7 ' + (EDITION_NAME || 'FULL GPS').toUpperCase(), 'info');
  };
  // keys: the countdown box by the clock, the disabled screen, the admin hour
  P.licenseChanged = function () {
    var a = this.access || {}, l = a.lic || {}, self = this;
    this.trialEnd = typeof l.cd === 'number' && !a.server ? Date.now() + l.cd * 1000 : null;
    this.trialLabel = 'Trial Time Remaining'; // only trial keys count down by the clock
    this.licEnd = l.on && typeof l.left === 'number' && !a.server ? Date.now() + l.left * 1000 : null; // the License tab's countdown (every key with an end)
    this.adminEnd = typeof a.admin === 'number' ? Date.now() + a.admin * 1000 : null;
    this.root.setAttribute('data-dead', l.dead && !a.server && !a.admin ? '1' : '0');
    this.root.setAttribute('data-bsod', l.bsod && !a.server && !a.admin ? '1' : '0'); // (the game script already leaves it off there)
    if (this.root.getAttribute('data-bsod') === '1') { this.openSheet(null); try { this.videoStop(); } catch (_) { } try { if (this.audio && !this.audio.paused) this.audio.pause(); } catch (_) { } }
    // the power-on screen: the player's name in place of the edition's word once a named key went in ('LESHII413 EDITION')
    if (this.el.bootSub && !ONYX) this.el.bootSub.textContent = '10\u2033 OFF-ROAD NAVIGATOR' + (l.name ? ' \u00b7 ' + String(l.name).toUpperCase() + ' EDITION' : EDITION_NAME ? ' \u00b7 ' + EDITION_NAME.toUpperCase() : '');
    clearInterval(this.trialTimer);
    if (this.trialEnd || this.adminEnd || this.licEnd) this.trialTimer = setInterval(function () { self.renderTrial(); if (self.sheet === 'menu' && self.menuTab === 'display') self.renderSheet(); }, 1000);
    this.renderTrial();
    if (this.el && this.m) { this.applySettings(); this.renderMedia(); } // the picture-in-picture choices follow the unlock
    if (this.sheet === 'menu') this.renderSheet();
  };
  P.renderTrial = function () {
    var el = this.el.trial, left = this.trialEnd && !ONYX ? Math.max(0, Math.floor((this.trialEnd - Date.now()) / 1000)) : null; // (no trial counter on the Onyx Edition; v3.3)
    if (left == null) { if (el.innerHTML) el.innerHTML = ''; el.classList.remove('show'); return; }
    var d = Math.floor(left / 86400), h = Math.floor(left % 86400 / 3600), m = Math.floor(left % 3600 / 60), sec = left % 60;
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    this.setHtml('trial', el, '<span>' + esc(this.trialLabel || 'Trial Time Remaining') + '</span><b>' + d + ':' + p2(h) + ':' + p2(m) + ':' + p2(sec) + '</b>');
    el.classList.add('show');
  };
  // Display: what's unlocked, and the key box
  P.licenseHtml = function () {
    var a = this.access || {}, l = a.lic || {}, st;
    var licLeft = this.licEnd ? Math.max(0, Math.floor((this.licEnd - Date.now()) / 1000)) : null;
    var days = function (secs) { // a live countdown: d:hh:mm:ss
      var t = licLeft != null ? licLeft : Math.max(0, Math.floor(secs)), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      return Math.floor(t / 86400) + ':' + p2(Math.floor(t % 86400 / 3600)) + ':' + p2(Math.floor(t % 3600 / 60)) + ':' + p2(t % 60);
    };
    if (this.adminEnd && this.adminEnd > Date.now()) { var al = Math.floor((this.adminEnd - Date.now()) / 1000); st = 'Admin access: every restriction off for ' + Math.floor(al / 60) + ':' + ((al % 60) < 10 ? '0' : '') + (al % 60) + ' more'; }
    else if (a.server) st = 'On a Baja75 server: everything is open';
    else if (a.password) st = 'Unlocked with the password until the game closes';
    else if (l.on && l.life) st = 'Unlocked for good';
    else if (l.on && l.bonus && typeof l.left === 'number') st = 'Extra day from a Baja75 server: ' + days(l.left) + ' left';
    else if (l.on && l.trial && typeof l.left === 'number') st = 'Trial: ' + days(l.left) + ' left';
    else if (l.on && typeof l.left === 'number') st = 'Unlocked: ' + days(l.left) + ' left';
    else if (l.why === 'server') st = 'Keys don\u2019t work on this server, only the password. Take a screenshot and send it to Baja75 for an unlocking key.';
    else if (l.why === 'pack') st = 'Your time has run out: ask Baja75 on Patreon for the unlocking pack';
    else if (l.why === 'ended') st = 'Your key\u2019s time has run out: get the next key from Baja75 on Patreon';
    else st = 'Locked off the Baja75 servers' + (COMMON ? '' : ' (the password or a license key unlocks it)');
    return '<div class="txl-sec"><h3>License</h3><div class="txl-row"><div class="grow"><div class="t1">' + esc(st) + '</div><div class="t2">A personal-use unlocking license can be bought from Baja75 on Patreon</div></div>' +
      (a.password ? btn('relock', 'LOCK') : '') + btn('keyOpen', 'ENTER KEY', 'blue') + '</div>' +
      '<div class="txl-note">When your key runs out, contact <b>Baja75 on Patreon</b> for another key, with your proof of purchase, your trial access, or where you found the mod.</div>' +
      '<div class="txl-note">Play an hour on a <b>Baja75 server</b> to earn an extra day (once a day).</div></div>';
  };
  // the Free Edition: a short pop-up that other features need the product key
  P.nudge = function () {
    var self = this, el = this.el.nudge;
    if (!el) return;
    el.classList.add('show');
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(function () { el.classList.remove('show'); }, 7000);
  };
  // the Onyx Edition's home screen: Music, Video, Maps, Settings, Gallery (button 1 = HOME)
  // v3.1.9: the theme in use (one this zip doesn't have = the standard Baja75 look)
  P.theme = function () { return ONYX ? THEMES[0] : themeOf(this.s.theme); };
  P.showHome = function (on) {
    if (!this.el.home) return;
    if (!on && this.galOn) this.galOpen(false);
    this.home = !!on;
    this.root.setAttribute('data-home', this.home ? '1' : '0');
    if (!this.isDash) { this.dashLast = null; this.dashSync(); }
    if (this.home) { this.openSheet(null); this.renderHome(); }
  };
  P.renderHome = function () {
    if (!this.el.home || !this.home) return;
    var h = this.hud || {}, d = new Date();
    this.el.home.querySelector('.h-clock').textContent = clockText(this.s.clockSource === 'game' && typeof h.tod === 'number' ? h.tod : null);
    this.el.home.querySelector('.h-date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  };
  P.homeGo = function (where) {
    var s = this.s;
    if (where === 'gallery') { // v3.4: the screenshots in a gallery view (Free / Common: BeamNG's screenshots folder, in Explorer)
      if (PLUS()) this.galOpen(true); else this.call('openFolder', luaStr('screenshots'));
      return;
    }
    if (where === 'video' && isFree()) { this.nudge(); return; } // the Free Edition: no video off the servers
    this.showHome(false);
    if (where === 'settings') { this.openSheet('menu'); this.menuTab = 'display'; this.renderSheet(); return; }
    s.display = where === 'music' ? 'music' : where === 'video' ? 'video' : 'gps';
    if (s.display !== 'gps') { if (where === 'music') s.musicScreen = true; else s.videoScreen = true; s.lastMedia = s.display; }
    this.save(); this.applySettings(); this.renderMedia(); this.renderAll();
  };
  P.renderVideoList = function () {
    if (!this.m) return;
    var self = this, list = arr(this.media.videos), rec = ONYX ? [] : arr(this.s.recentLinks), html = ''; // (Onyx: your own videos only)
    if (rec.length) {
      html += '<div class="ml-h">Recent links</div>' + rec.map(function (r, i) {
        return '<button class="ml-row' + (self.vid && self.vid.url === r.url ? ' on' : '') + '" data-act="vidRecent" data-v="' + i + '"><b>\u25b6</b><span>' + esc(r.title || r.url) + '</span></button>';
      }).join('');
    }
    html += '<div class="ml-h">' + (ONYX ? 'Up next' : 'Your videos') + ' <small>' + esc((this.media.paths && this.media.paths.videos) || 'settings/TreadXLGPS/videos') + '</small></div>';
    html += list.length ? list.map(function (v, i) {
      return '<button class="ml-row' + (self.vid && self.vid.kind === 'file' && self.vid.i === i ? ' on' : '') + '" data-act="vidLocal" data-v="' + i + '"><b>\u25b6</b><span>' + esc(v.file) + '</span>' + (v.maybe ? '<i>MP4: may not play</i>' : '') + '</button>';
    }).join('') : '<div class="ml-empty">Drop WebM videos in the videos folder, then press Rescan.</div>';
    html += '<div class="ml-btns">' + btn('openFolder', G.folder + '<span>Videos folder</span>', 'iconbtn', 'videos') + btn('mediaRescan', 'Rescan') + '</div>';
    this.setHtml('vlist', this.m.vlist, html);
  };
  P.renderMusicList = function () {
    if (!this.m) return;
    var self = this, list = arr(this.media.music);
    this.setHtml('mopts', this.m.opts,
      '<button class="mo' + (this.s.musicShuffle ? ' on' : '') + '" data-act="musShuffle">SHUFFLE ' + (this.s.musicShuffle ? 'ON' : 'OFF') + '</button>' +
      '<button class="mo' + (this.s.musicRepeat !== 'off' ? ' on' : '') + '" data-act="musRepeat">REPEAT ' + (this.s.musicRepeat === 'one' ? 'ONE' : this.s.musicRepeat === 'off' ? 'OFF' : 'ALL') + '</button>' +
      '<span class="grow"></span>' + btn('openFolder', G.folder + '<span>Music folder</span>', 'iconbtn', 'music') + btn('mediaRescan', 'Rescan'));
    var html = list.length ? list.map(function (t, i) {
      return '<button class="ml-row' + (self.mus.i === i ? ' on' : '') + '" data-act="musPlay" data-v="' + i + '"><b>' + (i + 1) + '</b><span>' + esc(t.file.replace(/\.[^.\/]+$/, '')) + '</span>' + (t.maybe ? '<i>may not play</i>' : '') + '</button>';
    }).join('') : '<div class="ml-empty">No music yet. Drop MP3, OGG, Opus, FLAC or WAV files in<br><span class="mono">' + esc((this.media.real && this.media.real.music) || (this.media.paths && this.media.paths.music) || 'settings/TreadXLGPS/music') + '</span><br>then press Rescan.</div>';
    this.setHtml('mlist', this.m.mlist, html);
  };
  // 4x a second: times, seek bars, play buttons, volume (never while a slider is being dragged)
  P.mediaTick = function (force) {
    if (!this.m || this.destroyed) return;
    var vp = this.vid ? '1' : '0';
    if (this.root.getAttribute('data-vplay') !== vp) this.root.setAttribute('data-vplay', vp); // a video on: the map goes to its corner
    this.musicGuard();
    this.renderMusicBar();
    var pk = this.panelKind();
    if (pk === 'gauges') { this.renderGauges(); return; }
    if (!pk && !force) return;
    var act = document.activeElement, m = this.m, self = this;
    var setRange = function (el, frac) { if (el && el !== act) el.value = String(Math.round(Math.max(0, Math.min(1, frac || 0)) * 1000)); };
    [].forEach.call(this.el.media.querySelectorAll('.mc-vol'), function (el) { if (el !== act) el.value = String(self.s.mediaVol); });
    [].forEach.call(this.el.media.querySelectorAll('.mc-b.mute'), function (el) { el.classList.toggle('on', !!self.s.mediaMuted); });
    var st = this.videoState();
    m.vctl.querySelector('.play').textContent = st && st.playing ? '\u275a\u275a' : '\u25b6';
    m.vctl.querySelector('.cur').textContent = fmtClock(st ? st.cur : 0);
    m.vctl.querySelector('.dur').textContent = fmtClock(st ? st.dur : 0);
    if (this.seeking !== 'vid') setRange(m.vctl.querySelector('.mc-seek'), st && st.dur ? st.cur / st.dur : 0);
    if (!this.vid && !/err/.test(m.msg.className)) this.vidMessage(ONYX ? 'Pick one of your videos below.' : 'Paste a YouTube link and press PLAY, or pick one of your videos below.');
    var a = this.audio, list = arr(this.media.music), t = list[this.mus.i];
    var playing = !!(a && !a.paused && t);
    m.mctl.querySelector('.play').textContent = playing ? '\u275a\u275a' : '\u25b6';
    var dur = a && isFinite(a.duration) ? a.duration : 0, cur = a && t ? a.currentTime || 0 : 0;
    m.mctl.querySelector('.cur').textContent = fmtClock(cur);
    m.mctl.querySelector('.dur').textContent = fmtClock(dur);
    if (this.seeking !== 'mus') setRange(m.mctl.querySelector('.mc-seek'), dur ? cur / dur : 0);
    this.setHtml('mnow', m.now, '<div class="mm-art">' + this.artHtml(t) + '</div><div class="mm-info">' + (t ? '<div class="nt">' + esc(t.file.replace(/\.[^.\/]+$/, '').split('/').pop()) + '</div><div class="ns">' + esc(t.file.indexOf('/') >= 0 ? t.file.split('/').slice(0, -1).join(' \u00b7 ') + ' \u00b7 ' : '') + 'Track ' + (this.mus.i + 1) + ' of ' + list.length + '</div>'
      : '<div class="nt">' + (list.length ? 'Press play' : 'No music yet') + '</div><div class="ns">' + list.length + ' song' + (list.length === 1 ? '' : 's') + ' in your music folder</div>') + '</div>');
    m.sub.textContent = pk === 'video' ? (this.vid ? (this.vid.title || (this.vid.kind === 'yt' ? 'YouTube' : '')) : '') : (t ? (playing ? 'Playing' : this.mus.held ? 'Waiting for the co-driver' : 'Paused') : '');
  };

  // ---- Chase / Rally: music waits while the co-driver reads pacenotes (unless Display says play anyway)
  P.musicBlocked = function () {
    if (this.s.musicWithCalls) return false;
    var md = modeOf(this.s.mode).id;
    if (md !== 'chase' && md !== 'rally') return false;
    var pn = this.hud && this.hud.pacenotes;
    return !!(pn && pn.calls);
  };
  P.musicAllowed = function () {
    if (!this.musicBlocked()) return true;
    this.toast('Music waits while the co-driver reads the pacenotes (MENU \u203a Display \u203a Music with co-driver calls)', 'info');
    return false;
  };
  // pauses the music when the calls start, and plays it again when they stop
  P.musicGuard = function () {
    var a = this.audio;
    if (!a || typeof a.pause !== 'function') return;
    var blocked = this.musicBlocked();
    if (blocked && !a.paused && this.mus.i >= 0) { a.pause(); this.mus.held = true; this.toast('Music paused: the co-driver is reading the pacenotes', 'info'); }
    else if (!blocked && this.mus.held && this.mus.i >= 0) { this.mus.held = false; try { var pr = a.play(); if (pr && pr.catch) pr.catch(function () { }); } catch (_) { } }
  };

  // ---- album art: the game finds it (embedded in the file, a same-name picture, or cover.jpg / folder.jpg) - TreadXLGPS.musicArt
  P.artHtml = function (t) {
    var a = t && this.arts && this.arts[t.path];
    return a ? '<img src="' + esc(mediaUrl(a)) + '" alt="">' : G.note;
  };
  P.askArt = function (t) {
    if (!t || !t.path) return;
    this.arts = this.arts || {};
    if (this.arts[t.path] !== undefined) return;
    this.arts[t.path] = ''; // asked
    this.call('musicArt', luaStr(t.path));
  };

  // ---- Chase / Rally: the CarPlay-style music bar under the waypoint list
  P.renderMusicBar = function () {
    var el = this.el.mbar;
    if (!el) return;
    var list = arr(this.media && this.media.music), c = capsOf(this.s.mode);
    var show = !!(this.barMode || (c.musicBar && this.s.musicBar && this.s.musicScreen && list.length && this.panelKind() !== 'music'));
    this.root.setAttribute('data-mbar', show ? '1' : '0');
    if (!show) return;
    var a = this.audio, t = list[this.mus.i], playing = !!(a && !a.paused && t), held = !!this.mus.held;
    var name = t ? t.file.replace(/\.[^.\/]+$/, '').split('/').pop() : 'Music';
    var sub = held ? 'Waits for the co-driver' : t ? (playing ? 'Playing' : 'Paused') + ' \u00b7 ' + (this.mus.i + 1) + ' of ' + list.length : list.length + ' song' + (list.length === 1 ? '' : 's') + ' \u00b7 press play';
    var art = this.artHtml(t);
    var key = name + '|' + sub + '|' + playing + '|' + art;
    if (key !== this.mbarKey) {
      this.mbarKey = key;
      el.querySelector('.mb-art').innerHTML = art;
      el.querySelector('.mb-t').textContent = name;
      el.querySelector('.mb-s').textContent = sub;
      el.querySelector('.play').textContent = playing ? '\u275a\u275a' : '\u25b6';
      el.classList.toggle('held', held);
    }
    var dur = a && isFinite(a.duration) ? a.duration : 0, cur = a && t ? a.currentTime || 0 : 0;
    el.querySelector('.mb-prog b').style.width = (dur ? Math.min(100, cur / dur * 100) : 0).toFixed(1) + '%';
  };

  // ---- Tuner: the gauge panel (full screen, or the split side) on the device's own bezel background
  P.gaugeData = function () {
    var now = Date.now(), tl = this.telx && now - (this.telAt || 0) < 2500 ? this.telx : null, el = this.elx && now - (this.elxAt || 0) < 2500 ? this.elx : null;
    var g = function (k) { if (el && isFinite(el[k])) return Number(el[k]); if (tl && isFinite(tl[k])) return Number(tl[k]); return null; };
    var num = function (o, k) { return o && isFinite(o[k]) ? Number(o[k]) : null; };
    return {
      ok: !!(el || tl), rpm: g('rpm'), gear: el && el.gear != null ? el.gear : tl ? tl.gear : null, throttle: g('throttle'), brake: g('brake'), clutch: g('clutch'),
      water: g('watertemp'), oil: g('oiltemp'), fuel: g('fuel'), boost: g('turboBoost'), maxrpm: num(tl, 'maxrpm'), battery: num(tl, 'battery'),
      running: tl && isFinite(tl.running) ? Number(tl.running) : num(el, 'engineRunning'), gx: num(tl, 'gx'), gy: num(tl, 'gy')
    };
  };
  function dialSvg(maxRpm) {
    var k = Math.max(3, Math.min(20, Math.ceil((maxRpm || 7000) / 1000))), max = k * 1000, red = (maxRpm || max) * 0.9;
    var A0 = 135, SW = 270;
    var pt = function (a, r) { var t = a * Math.PI / 180; return [100 + r * Math.cos(t), 100 + r * Math.sin(t)]; };
    var P2 = function (a, r) { var q = pt(a, r); return q[0].toFixed(1) + ' ' + q[1].toFixed(1); };
    var arc = function (a0, a1, r) { return 'M' + P2(a0, r) + ' A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + P2(a1, r); };
    var out = '<svg viewBox="0 0 200 200" class="gg-dial"><path d="' + arc(A0, A0 + SW, 88) + '" class="gg-track"/>' +
      '<path d="' + arc(A0 + SW * Math.min(1, red / max), A0 + SW, 88) + '" class="gg-red"/>';
    for (var i = 0; i <= k * 2; i++) {
      var a = A0 + SW * i / (k * 2), major = i % 2 === 0;
      out += '<path d="M' + P2(a, major ? 72 : 78) + ' L' + P2(a, 84) + '" class="gg-tick' + (major ? ' major' : '') + (i / 2 * 1000 >= red ? ' hot' : '') + '"/>';
      if (major) { var q = pt(a, 61); out += '<text x="' + q[0].toFixed(1) + '" y="' + q[1].toFixed(1) + '" class="gg-num">' + (i / 2) + '</text>'; }
    }
    out += '<text x="100" y="168" class="gg-x">\u00d71000 RPM</text><g class="gg-needle"><path d="M100 100 L' + P2(A0, 80) + '"/></g><circle cx="100" cy="100" r="7" class="gg-hub"/></svg>';
    return { svg: out, max: max };
  }
  P.renderGauges = function (full) {
    var box = this.el.media.querySelector('.md-gauges');
    if (!box) return;
    var d = this.gaugeData(), u = this.s.units, self = this;
    var maxKey = d.maxrpm ? Math.ceil(d.maxrpm / 1000) : 0;
    if (full || !this.gg || this.gg.maxKey !== maxKey) {
      var dial = dialSvg(d.maxrpm);
      box.innerHTML = '<div class="gg-tach">' + dial.svg + '<div class="gg-mid"><div class="gg-gear">-</div><div class="gg-rpm"></div></div><div class="gg-spd"><b></b><small></small></div></div>' +
        '<div class="gg-side"><div class="gg-pedals">' + [['thr', 'THR'], ['brk', 'BRK'], ['clu', 'CLU']].map(function (p) { return '<div class="gg-ped ' + p[0] + '"><i><b></b></i><span>' + p[1] + '</span></div>'; }).join('') + '</div>' +
        '<div class="gg-g"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" class="gg-ring"/><circle cx="50" cy="50" r="23" class="gg-ring in"/><path d="M50 4 V96 M4 50 H96" class="gg-cross"/><circle cx="50" cy="50" r="6" class="gg-dot"/></svg><span class="gg-gv"></span></div></div>' +
        '<div class="gg-tiles">' + [['water', 'WATER'], ['oil', 'OIL'], ['fuel', 'FUEL'], ['boost', 'BOOST'], ['battery', 'BATTERY']].map(function (t) { return '<div class="gg-t" data-g="' + t[0] + '"><div class="k">' + t[1] + '</div><div class="v">--</div></div>'; }).join('') + '</div>' +
        '<div class="gg-wait">Waiting for the vehicle\u2026</div>';
      this.gg = { maxKey: maxKey, max: dial.max };
    }
    var q = function (sel) { return box.querySelector(sel); };
    box.classList.toggle('nodata', !d.ok);
    var f = d.rpm != null ? Math.max(0, Math.min(1.04, d.rpm / this.gg.max)) : 0;
    q('.gg-needle').style.transform = 'rotate(' + (f * 270).toFixed(1) + 'deg)';
    var g = d.gear;
    if (typeof g === 'number') g = g === 0 ? 'N' : g < 0 ? 'R' : String(g);
    q('.gg-gear').textContent = g != null && g !== '' ? String(g).slice(0, 3) : '-';
    q('.gg-rpm').textContent = d.rpm != null ? Math.round(d.rpm / 10) * 10 + ' RPM' : '';
    var sp = fmtSpeed((this.hud || {}).speed, u);
    q('.gg-spd b').textContent = sp.v; q('.gg-spd small').textContent = sp.u.toUpperCase();
    var ped = function (cls, v) { q('.gg-ped.' + cls + ' b').style.height = (v != null ? Math.max(0, Math.min(1, v)) * 100 : 0).toFixed(0) + '%'; };
    ped('thr', d.throttle); ped('brk', d.brake); ped('clu', d.clutch);
    var gx = d.gx || 0, gy = d.gy || 0, gs = 36 / 1.5;
    var dot = q('.gg-dot');
    dot.setAttribute('cx', (50 + Math.max(-1.8, Math.min(1.8, gx)) * gs).toFixed(1));
    dot.setAttribute('cy', (50 + Math.max(-1.8, Math.min(1.8, gy)) * gs).toFixed(1));
    q('.gg-gv').textContent = d.gx != null ? Math.sqrt(gx * gx + gy * gy).toFixed(2) + ' G' : 'G';
    var tile = function (k, val) { var el = box.querySelector('.gg-t[data-g="' + k + '"] .v'); if (el) el.innerHTML = val ? esc(val[0]) + '<small>' + esc(val[1] || '') + '</small>' : '--'; };
    tile('water', d.water != null ? tempOf(d.water, u) : null);
    tile('oil', d.oil != null ? tempOf(d.oil, u) : null);
    tile('fuel', d.fuel != null ? [String(Math.round(d.fuel * 100)), '%'] : null);
    tile('boost', d.boost != null ? (u === 'metric' ? [(d.boost * 0.0689476).toFixed(2), 'bar'] : [d.boost.toFixed(1), 'psi']) : null);
    tile('battery', d.battery != null ? [String(Math.round(d.battery * 100)), '%'] : d.running != null ? [d.running > 0.5 ? 'CHG' : 'OFF', ''] : null);
    void self;
  };

  // ---------------------------------------------------------------- course map picture (server pack / GPX export)
  // Lua sends the course (line, symbols, pacenotes, info) when it goes into the server pack or out as GPX; the picture
  // is drawn here at 1920 x 1080 and goes back to Lua as a JPEG in base64 pieces (TreadXLGPS.snapChunk).
  var SNAP = { W: 1920, H: 1080, BAND: 150, CHUNK: 60000, FONT: '"TXL Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif' };
  function snapColor(c, fb) { return String(bngColor(c, fb)).replace(/var\(--[\w-]+,\s*([^)]+)\)/g, '$1'); }
  function loadImage(src, cb) {
    var im = new Image(), done = false;
    var fin = function (ok) { if (done) return; done = true; cb(ok ? im : null); };
    im.onload = function () { fin(im.naturalWidth > 0); };
    im.onerror = function () { fin(false); };
    setTimeout(function () { fin(false); }, 15000);
    im.src = src;
  }
  function svgUrl(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
  function glyphSvg(type, color, mirror) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24"><g color="' + color + '" style="color:' + color + '"' +
      (mirror ? ' transform="translate(24 0) scale(-1 1)"' : '') + '>' + (PN_GLYPH[type] || PN_GLYPH.dot) + '</g></svg>';
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  // "satellite": the terrain heightmap, smoothed, lit from the north-west and tinted like dry ground
  function drawRelief(ctx, im, x0, y0, w, h, W, H) {
    var off = document.createElement('canvas'); off.width = W; off.height = H;
    var o = off.getContext('2d');
    o.imageSmoothingEnabled = true;
    o.drawImage(im, x0, y0, w, h);
    var src, out;
    try { src = o.getImageData(0, 0, W, H); out = ctx.getImageData(0, 0, W, H); } catch (_) {
      ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.8; ctx.drawImage(im, x0, y0, w, h);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      return;
    }
    var ix0 = Math.max(1, Math.floor(x0)), iy0 = Math.max(1, Math.floor(y0)), ix1 = Math.min(W - 1, Math.ceil(x0 + w)), iy1 = Math.min(H - 1, Math.ceil(y0 + h));
    if (ix1 <= ix0 || iy1 <= iy0) return;
    var d = src.data, hg = new Float32Array(W * H), tmp = new Float32Array(W * H), lo = 1e9, hi = -1e9, x, y, k;
    for (y = iy0; y < iy1; y++) for (x = ix0; x < ix1; x++) { k = y * W + x; hg[k] = d[4 * k]; }
    // two box-blur passes hide the 8-bit steps of a 16-bit heightmap
    var R = 3;
    for (var pass = 0; pass < 2; pass++) {
      for (y = iy0; y < iy1; y++) { var acc = 0, cnt = 0; for (x = ix0; x < Math.min(ix1, ix0 + R); x++) { acc += hg[y * W + x]; cnt++; }
        for (x = ix0; x < ix1; x++) { if (x + R < ix1) { acc += hg[y * W + x + R]; cnt++; } if (x - R - 1 >= ix0) { acc -= hg[y * W + x - R - 1]; cnt--; } tmp[y * W + x] = acc / cnt; } }
      for (x = ix0; x < ix1; x++) { var acc2 = 0, cnt2 = 0; for (y = iy0; y < Math.min(iy1, iy0 + R); y++) { acc2 += tmp[y * W + x]; cnt2++; }
        for (y = iy0; y < iy1; y++) { if (y + R < iy1) { acc2 += tmp[(y + R) * W + x]; cnt2++; } if (y - R - 1 >= iy0) { acc2 -= tmp[(y - R - 1) * W + x]; cnt2--; } hg[y * W + x] = acc2 / cnt2; } }
    }
    for (y = iy0; y < iy1; y++) for (x = ix0; x < ix1; x++) { k = y * W + x; if (hg[k] < lo) lo = hg[k]; if (hg[k] > hi) hi = hg[k]; }
    var span = Math.max(1, hi - lo), ex = 420 / span / Math.max(1, Math.sqrt(W * H) / Math.max(w, h) * 2);
    var lx = -0.55, ly = -0.55, lz = 0.63, od = out.data;
    var pal = [[150, 128, 92], [198, 176, 132], [222, 206, 168], [160, 146, 120]];
    for (y = iy0; y < iy1; y++) for (x = ix0; x < ix1; x++) {
      k = y * W + x;
      var gx = (hg[k + 1] - hg[k - 1]) * ex, gy = (hg[k + W] - hg[k - W]) * ex;
      var nl = Math.sqrt(gx * gx + gy * gy + 1), sh = (-gx * lx - gy * ly + lz) / nl;
      sh = Math.max(0.5, Math.min(1.15, 0.5 + sh * 0.62));
      var t = (hg[k] - lo) / span * 3, i0 = Math.min(2, Math.floor(t)), f = t - i0, a = pal[i0], b = pal[i0 + 1];
      od[4 * k] = Math.min(255, (a[0] + (b[0] - a[0]) * f) * sh);
      od[4 * k + 1] = Math.min(255, (a[1] + (b[1] - a[1]) * f) * sh);
      od[4 * k + 2] = Math.min(255, (a[2] + (b[2] - a[2]) * f) * sh);
      od[4 * k + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  }
  // draws the picture; done(jpegDataUrl, background used: 'map' | 'satellite' | 'none') or done(null, reason)
  function drawSnapshot(job, base, opts, done) {
    var W = SNAP.W, H = SNAP.H, MH = H - SNAP.BAND, F = SNAP.FONT, u = opts.units === 'metric' ? 'metric' : 'imperial';
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var flat = arr(job.flat), wpts = arr(job.wpts), n = flat.length / 2;
    // fit the course and its symbols into the map area (north up)
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    var grow = function (x, y) { if (!isFinite(x) || !isFinite(y)) return; bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); };
    for (var i = 0; i + 1 < flat.length; i += 2) grow(flat[i], flat[i + 1]);
    wpts.forEach(function (w) { grow(Number(w.x), Number(w.y)); });
    if (!isFinite(bb[0])) bb = [-100, -100, 100, 100];
    var bw = Math.max(80, bb[2] - bb[0]), bh = Math.max(80, bb[3] - bb[1]), pad = 110;
    var sc = Math.min((W - 2 * pad) / bw, (MH - 2 * pad) / bh, 4);
    var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    var X = function (x) { return W / 2 + (x - cx) * sc; }, Y = function (y) { return MH / 2 - (y - cy) * sc; };
    var mapTiles = opts.noTiles ? [] : arr(job.mapTiles), sat = !opts.noTiles && job.satTile && job.satTile.image ? job.satTile : null;
    var tiles = opts.style === 'satellite' ? (sat ? [sat] : mapTiles) : (mapTiles.length ? mapTiles : (sat ? [sat] : []));
    var pns = [], loads = [], seen = {};
    var need = function (key, src) { if (!seen[key]) { seen[key] = 1; loads.push([key, src]); } };
    tiles.forEach(function (t, k) { need('t' + k, String(t.image).charAt(0) === '/' ? String(t.image) : '/' + t.image); });
    wpts.forEach(function (w) {
      if (w.kind === 'pacenote') {
        var t = pnMain(w.vis);
        if (!t) return;
        var fg = snapColor(t.colorNoteIcon, '#f2f2f2'), gk = (t.type || 'dot') + '|' + fg + '|' + (t.isLeft ? 1 : 0);
        pns.push({ w: w, t: t, gk: gk });
        need('g:' + gk, svgUrl(glyphSvg(t.type, fg, t.isLeft)));
      } else if (w.icon) need('i:' + w.icon, ICON_DIR + w.icon);
    });
    var got = {}, left = loads.length;
    if (!left) paint();
    loads.forEach(function (l) { loadImage(l[1], function (im) { got[l[0]] = im; if (--left === 0) paint(); }); });

    function paint() {
      // background: the game's map image, or the terrain heightmap (satellite), or sand + a 250 m grid
      ctx.fillStyle = '#ddd0aa'; ctx.fillRect(0, 0, W, MH);
      var used = 'none';
      tiles.forEach(function (t, k) {
        var im = got['t' + k];
        if (!im) return;
        var x0 = X(Number(t.x)), y0 = Y(Number(t.y)), w = Number(t.w) * sc, h = Number(t.h) * sc;
        if (t.height) { drawRelief(ctx, im, x0, y0, w, h, W, MH); used = 'satellite'; } else { ctx.drawImage(im, x0, y0, w, h); used = 'map'; }
      });
      if (used === 'none') {
        ctx.strokeStyle = 'rgba(120, 100, 70, 0.25)'; ctx.lineWidth = 1; ctx.beginPath();
        var g0x = Math.floor((cx - W / 2 / sc) / 250) * 250, g0y = Math.floor((cy - MH / 2 / sc) / 250) * 250;
        for (var gx = g0x; X(gx) < W; gx += 250) { ctx.moveTo(X(gx), 0); ctx.lineTo(X(gx), MH); }
        for (var gy = g0y; Y(gy) > 0; gy += 250) { ctx.moveTo(0, Y(gy)); ctx.lineTo(W, Y(gy)); }
        ctx.stroke();
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // roads (the AI road graph, like the GPS screen)
      var bp = arr(base && base.pts), be = arr(base && base.edges), roads = [[], [], []];
      for (var e = 0; e + 2 < be.length; e += 3) {
        var a = be[e] * 3, c = be[e + 1] * 3;
        if (a + 2 >= bp.length || c + 2 >= bp.length) continue;
        var x1 = X(bp[a]), y1 = Y(bp[a + 1]), x2 = X(bp[c]), y2 = Y(bp[c + 1]);
        if (Math.max(x1, x2) < -30 || Math.min(x1, x2) > W + 30 || Math.max(y1, y2) < -30 || Math.min(y1, y2) > MH + 30) continue;
        var dr = (be[e + 2] || 100) / 100;
        roads[dr <= 0.1 ? 0 : dr < 0.9 ? 1 : 2].push([x1, y1, x2, y2, Math.max(0.5, Math.min(8, (bp[a + 2] + bp[c + 2]) / 2))]);
      }
      var stroke = function (list, color, wf, minpx, dash) {
        ctx.strokeStyle = color; ctx.setLineDash(dash || []);
        list.forEach(function (r) { ctx.lineWidth = Math.min(16, Math.max(minpx, r[4] * 2 * sc * wf)); ctx.beginPath(); ctx.moveTo(r[0], r[1]); ctx.lineTo(r[2], r[3]); ctx.stroke(); });
        ctx.setLineDash([]);
      };
      ctx.globalAlpha = used === 'satellite' ? 0.75 : 1;
      stroke(roads[0], '#7a5a3a', 1, 1.6, [6, 4]);
      stroke(roads[1], '#b48a52', 1, 2.2);
      stroke(roads[2], '#8f846c', 1.25, 4);
      stroke(roads[2], '#ffffff', 1, 2.6);
      ctx.globalAlpha = 1;
      // the course line with direction chevrons
      if (n >= 2) {
        ctx.beginPath();
        for (i = 0; i < n; i++) { var px = X(flat[2 * i]), py = Y(flat[2 * i + 1]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
        ctx.strokeStyle = 'rgba(10, 10, 12, 0.85)'; ctx.lineWidth = 14; ctx.stroke();
        ctx.strokeStyle = opts.color || '#e8178a'; ctx.lineWidth = 8; ctx.stroke();
        var run = 0, next = 120;
        ctx.fillStyle = '#ffffff';
        for (i = 1; i < n; i++) {
          var ax = X(flat[2 * i - 2]), ay = Y(flat[2 * i - 1]), bx = X(flat[2 * i]), by = Y(flat[2 * i + 1]), L = Math.hypot(bx - ax, by - ay);
          while (L > 0 && run + L >= next) {
            var f = (next - run) / L, qx = ax + (bx - ax) * f, qy = ay + (by - ay) * f, an = Math.atan2(by - ay, bx - ax);
            ctx.save(); ctx.translate(qx, qy); ctx.rotate(an); ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-3, -4.5); ctx.lineTo(-1, 0); ctx.lineTo(-3, 4.5); ctx.closePath(); ctx.fill(); ctx.restore();
            next += 170;
          }
          run += L;
        }
      }
      // labels never on top of each other
      var boxes = [];
      var free = function (x, y, w, h) { for (var q = 0; q < boxes.length; q++) { var o = boxes[q]; if (x < o[0] + o[2] && x + w > o[0] && y < o[1] + o[3] && y + h > o[1]) return false; } return x >= 4 && y >= 4 && x + w <= W - 4 && y + h <= MH - 4; };
      var pill = function (text, x, y, color, size) {
        ctx.font = '800 ' + (size || 22) + 'px ' + F;
        var w = ctx.measureText(text).width + 18, h = (size || 22) + 12;
        var spots = [[x + 26, y - h / 2], [x - 26 - w, y - h / 2], [x - w / 2, y + 26], [x - w / 2, y - 26 - h], [x + 26, y + 6], [x + 26, y - h - 6]];
        var pos = spots[0];
        for (var q = 0; q < spots.length; q++) if (free(spots[q][0], spots[q][1], w, h)) { pos = spots[q]; break; }
        boxes.push([pos[0], pos[1], w, h]);
        ctx.fillStyle = 'rgba(17, 19, 22, 0.88)'; rrect(ctx, pos[0], pos[1], w, h, 6); ctx.fill();
        ctx.fillStyle = color || '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(text, pos[0] + 9, pos[1] + h / 2 + 1);
      };
      // start / finish
      if (n >= 2) {
        var sx = X(flat[0]), sy = Y(flat[1]), fx = X(flat[2 * n - 2]), fy = Y(flat[2 * n - 1]);
        var loop = Math.hypot(flat[0] - flat[2 * n - 2], flat[1] - flat[2 * n - 1]) < 40;
        // the course's own start / finish symbols already say it
        var marked = function (x, y) { return wpts.some(function (w) { return w.kind === 'start' && Math.hypot(Number(w.x) - x, Number(w.y) - y) < 40; }); };
        var markS = !marked(flat[0], flat[1]), markF = !loop && !marked(flat[2 * n - 2], flat[2 * n - 1]);
        var checker = function (x, y) {
          ctx.save(); ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.clip();
          for (var r = 0; r < 6; r++) for (var q = 0; q < 6; q++) { ctx.fillStyle = (r + q) % 2 ? '#111' : '#fff'; ctx.fillRect(x - 18 + q * 6, y - 18 + r * 6, 6, 6); }
          ctx.restore(); ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.lineWidth = 4; ctx.strokeStyle = '#111'; ctx.stroke();
        };
        if (markF) { checker(fx, fy); boxes.push([fx - 20, fy - 20, 40, 40]); }
        if (markS) {
          ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2); ctx.fillStyle = '#22b05a'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.font = '900 18px ' + F; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('S', sx, sy + 1); ctx.textAlign = 'left';
          boxes.push([sx - 20, sy - 20, 40, 40]);
          pill(loop ? 'START / FINISH' : 'START', sx, sy, '#7dffb0');
        }
        if (markF) pill('FINISH', fx, fy, '#ffffff');
      }
      // VCPs, pits, speed zones, hazards: the GPS symbols with their names
      wpts.forEach(function (w) {
        if (w.kind === 'pacenote') return;
        var im = got['i:' + w.icon], x = X(Number(w.x)), y = Y(Number(w.y));
        if (im) ctx.drawImage(im, x - 22, y - 22, 44, 44); else { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = '#1d8cff'; ctx.fill(); }
        boxes.push([x - 22, y - 22, 44, 44]);
      });
      wpts.forEach(function (w) {
        if (w.kind === 'pacenote') return;
        var txt = String(w.label || '');
        if (w.kind === 'zone' && w.limitMph) txt = (txt && txt !== 'Waypoint' ? txt + ' \u00b7 ' : '') + mphTo(w.limitMph, u) + (u === 'metric' ? ' KM/H' : ' MPH');
        if (txt && txt !== 'Waypoint') pill(txt, X(Number(w.x)), Y(Number(w.y)), w.kind === 'vcp' ? '#9fd0ff' : w.kind === 'zone' || w.kind === 'zoneEnd' ? '#ffd27a' : '#ffffff', 21);
      });
      // pacenotes: BeamNG-style tiles (corner glyph + number) next to the course, with a leader to the spot
      pns.forEach(function (p) {
        var t = p.t, x = X(Number(p.w.x)), y = Y(Number(p.w.y)), T = 50;
        var bgc = t.background || {}, bg = snapColor(bgc.color, '#2a2e34'), st = snapColor(bgc.strokeColor, bg), tx = snapColor(t.colorNoteText, snapColor(t.colorNoteIcon, '#f2f2f2'));
        var spots = [], q;
        for (q = 0; q < 8; q++) { var an = -Math.PI / 4 + q * Math.PI / 4; spots.push([x + Math.cos(an) * 52 - T / 2, y + Math.sin(an) * 52 - T / 2]); }
        for (q = 0; q < 8; q++) { var an2 = -Math.PI / 8 + q * Math.PI / 4; spots.push([x + Math.cos(an2) * 92 - T / 2, y + Math.sin(an2) * 92 - T / 2]); }
        var pos = null;
        for (q = 0; q < spots.length && !pos; q++) if (free(spots[q][0], spots[q][1], T, T)) pos = spots[q];
        if (!pos) pos = spots[0];
        boxes.push([pos[0], pos[1], T, T]);
        ctx.strokeStyle = 'rgba(17, 19, 22, 0.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(pos[0] + T / 2, pos[1] + T / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#111'; ctx.stroke();
        rrect(ctx, pos[0], pos[1], T, T, 7); ctx.fillStyle = bg; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = st; ctx.stroke();
        var gi = got['g:' + p.gk];
        if (gi) ctx.drawImage(gi, pos[0] + 3, pos[1] + 3, t.turnTypeValue ? 34 : 44, t.turnTypeValue ? 34 : 44);
        if (t.turnTypeValue) {
          ctx.font = '900 ' + (String(t.turnTypeValue).length > 1 ? 17 : 22) + 'px ' + F; ctx.fillStyle = tx; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(String(t.turnTypeValue), pos[0] + T - 5, pos[1] + T - 5); ctx.textAlign = 'left';
        }
        if (t.additionalNote) { ctx.beginPath(); ctx.arc(pos[0] + T - 4, pos[1] + 4, 7, 0, Math.PI * 2); ctx.fillStyle = snapColor(t.additionalNote.colorBg, '#ffcf33'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#111'; ctx.stroke(); }
      });
      // north arrow and scale bar
      ctx.save(); ctx.translate(W - 70, 70);
      ctx.beginPath(); ctx.arc(0, 0, 38, 0, Math.PI * 2); ctx.fillStyle = 'rgba(17, 19, 22, 0.85)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -27); ctx.lineTo(11, 8); ctx.lineTo(0, 2); ctx.lineTo(-11, 8); ctx.closePath(); ctx.fillStyle = '#ff6a13'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '900 18px ' + F; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', 0, 22); ctx.restore(); ctx.textAlign = 'left';
      var steps = u === 'metric' ? [[10, '10 m'], [20, '20 m'], [50, '50 m'], [100, '100 m'], [200, '200 m'], [500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km'], [10000, '10 km']]
        : [[50 * M_PER_FT, '50 ft'], [100 * M_PER_FT, '100 ft'], [200 * M_PER_FT, '200 ft'], [500 * M_PER_FT, '500 ft'], [1000 * M_PER_FT, '1000 ft'], [0.5 * M_PER_MI, '0.5 mi'], [M_PER_MI, '1 mi'], [2 * M_PER_MI, '2 mi'], [5 * M_PER_MI, '5 mi']];
      var stp = steps[0];
      for (q = 0; q < steps.length; q++) if (steps[q][0] * sc <= 300) stp = steps[q];
      var sw = stp[0] * sc, sx0 = W - 40 - sw, sy0 = MH - 34;
      ctx.fillStyle = 'rgba(17, 19, 22, 0.85)'; rrect(ctx, sx0 - 16, sy0 - 34, sw + 32, 52, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(sx0, sy0, sw, 5); ctx.fillRect(sx0, sy0 - 8, 3, 13); ctx.fillRect(sx0 + sw - 3, sy0 - 8, 3, 13);
      ctx.font = '800 20px ' + F; ctx.textBaseline = 'alphabetic'; ctx.fillText(stp[1], sx0, sy0 - 12);
      // title band: course, map, distance, elevation change
      ctx.fillStyle = '#111317'; ctx.fillRect(0, MH, W, SNAP.BAND);
      ctx.fillStyle = '#ff6a13'; ctx.fillRect(0, MH, W, 6);
      ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = '900 56px ' + F;
      ctx.fillText(String(job.title || job.name || 'Course').toUpperCase(), 44, MH + 70);
      var mi = (Number(job.length) || 0) / M_PER_MI, km = (Number(job.length) || 0) / 1000, ev = job.elev;
      var mf = function (m) { return Math.round(m) + ' m / ' + Math.round(m / M_PER_FT) + ' ft'; };
      var items = [['MAP', String(job.mapName || job.level || '')], ['DISTANCE', mi.toFixed(2) + ' mi / ' + km.toFixed(2) + ' km'],
        ['ELEVATION CHANGE', ev ? mf(ev.hi - ev.lo) + '  (climb ' + mf(ev.up) + ')' : '-']];
      var npn = pns.length, nvcp = wpts.filter(function (w) { return w.kind === 'vcp'; }).length;
      if (npn) items.push(['PACENOTES', String(npn)]);
      if (nvcp) items.push(['VCPs', String(nvcp)]);
      var ix = 46;
      items.forEach(function (it) {
        ctx.font = '800 18px ' + F; ctx.fillStyle = '#9aa2ad'; ctx.fillText(it[0], ix, MH + 104);
        var lw = ctx.measureText(it[0]).width;
        ctx.font = '800 27px ' + F; ctx.fillStyle = '#ffffff'; ctx.fillText(it[1], ix, MH + 134);
        ix += Math.max(ctx.measureText(it[1]).width, lw, 90) + 46;
      });
      ctx.textAlign = 'right'; ctx.font = '900 30px ' + F; ctx.fillStyle = '#ffffff'; ctx.fillText('BAJA75 NAVIGATION UNIT', W - 44, MH + 58);
      ctx.font = '800 20px ' + F; ctx.fillStyle = '#ff6a13'; ctx.fillText('BAJA75 CHASE EDITION', W - 44, MH + 86);
      ctx.fillStyle = '#9aa2ad'; ctx.fillText((used === 'satellite' ? 'Satellite (terrain heightmap)' : used === 'map' ? 'BeamNG map' : 'No map image') + ' \u00b7 ' + (function (d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); })(new Date()), W - 44, MH + 116);
      ctx.textAlign = 'left';
      var url = null;
      try { url = cv.toDataURL('image/jpeg', 0.9); } catch (err) { url = null; }
      if (url && url.indexOf('data:image/jpeg') === 0) { done(url, used); return; }
      // a map image the canvas may not export: draw it again without one
      if (tiles.length && !opts.noTiles) { drawSnapshot(job, base, { style: opts.style, color: opts.color, units: opts.units, noTiles: true }, done); return; }
      done(null, 'the picture could not be exported');
    }
  }
  TreadXLApp.drawSnapshot = drawSnapshot; // for the dev previews

  P.makeSnapshot = function (d) {
    if (!d || !d.id) return;
    var self = this, id = String(d.id);
    try {
      drawSnapshot(d, this.baseData, { style: this.s.snapStyle, color: this.s.courseColor, units: this.s.units }, function (url, used) {
        if (!url) { self.call('snapFailed', luaStr(id) + ', ' + luaStr(used || 'could not draw')); return; }
        var b64 = url.slice(url.indexOf(',') + 1), parts = Math.ceil(b64.length / SNAP.CHUNK);
        for (var i = 0; i < parts; i++) self.call('snapChunk', luaStr(id) + ', ' + (i + 1) + ', ' + parts + ', "' + b64.slice(i * SNAP.CHUNK, (i + 1) * SNAP.CHUNK) + '"');
        self.lastSnapshot = { id: id, url: url, used: used, bytes: Math.round(b64.length * 3 / 4) };
      });
    } catch (err) {
      this.call('snapFailed', luaStr(id) + ', ' + luaStr(String((err && err.message) || err)));
    }
  };

  // ---------------------------------------------------------------- gallery (v3.4): BeamNG's screenshots, 6 to a page
  P.galOpen = function (on) {
    this.galOn = !!on;
    this.root.setAttribute('data-gal', on ? '1' : '0');
    if (!on) { this.galShow(-1); return; }
    this.galPage = 0; this.galData = null;
    this.renderGallery();
    this.call('requestGallery');
  };
  P.renderGallery = function () {
    var el = this.el.gal;
    if (!el || !this.galOn) return;
    var d = this.galData, shots = d ? arr(d.shots) : null, per = 6;
    var pages = shots ? Math.max(1, Math.ceil(shots.length / per)) : 1;
    this.galPage = Math.min(this.galPage || 0, pages - 1);
    el.querySelector('.g-n').textContent = shots ? (d.total > shots.length ? ' \u00b7 newest ' + shots.length + ' of ' + d.total : ' \u00b7 ' + shots.length) : '';
    var grid = el.querySelector('.g-grid'), pg = el.querySelector('.g-pg'), self = this;
    if (!shots) { grid.innerHTML = '<div class="g-empty">Loading your screenshots\u2026</div>'; pg.innerHTML = ''; return; }
    if (!shots.length) { grid.innerHTML = '<div class="g-empty">No screenshots yet. Take one in the game (F12 by default); they are saved in<br><span class="mono">' + esc(d.real || 'screenshots') + '</span></div>'; pg.innerHTML = ''; return; }
    var from = this.galPage * per;
    grid.innerHTML = shots.slice(from, from + per).map(function (sh, k) {
      return '<button class="g-t" data-act="galShow" data-v="' + (from + k) + '"><img loading="lazy" alt="" src="' + esc(mediaUrl(sh.path)) + '"><span>' + esc(sh.name) + '</span></button>';
    }).join('');
    [].forEach.call(grid.querySelectorAll('img'), function (im) {
      im.addEventListener('error', function () { im.parentNode.classList.add('bad'); self.galBad = (self.galBad || 0) + 1; self.renderGalleryNote(); });
    });
    pg.innerHTML = pages > 1 ? '<button class="txl-btn" data-act="galPage" data-v="' + (this.galPage - 1) + '"' + (this.galPage ? '' : ' disabled') + '>\u2039 NEWER</button><span>' + (this.galPage + 1) + ' / ' + pages + '</span><button class="txl-btn" data-act="galPage" data-v="' + (this.galPage + 1) + '"' + (this.galPage < pages - 1 ? '' : ' disabled') + '>OLDER \u203a</button>' : '';
    this.renderGalleryNote();
  };
  // pictures the screen can't open (an older game, a file being written): said once, with the folder button
  P.renderGalleryNote = function () {
    var el = this.el.gal;
    if (!el) return;
    var n = el.querySelector('.g-note');
    if (this.galBad && !n) { n = document.createElement('div'); n.className = 'g-note'; n.textContent = 'Some screenshots can\u2019t be shown here: OPEN FOLDER shows them all.'; el.appendChild(n); }
    if (!this.galBad && n) n.parentNode.removeChild(n);
  };
  P.galShow = function (i) {
    var v = this.el.galView, shots = this.galData ? arr(this.galData.shots) : [];
    if (!v) return;
    if (!(i >= 0 && i < shots.length)) { this.galIdx = -1; this.root.setAttribute('data-galview', '0'); return; }
    this.galIdx = i;
    v.querySelector('img').src = mediaUrl(shots[i].path);
    v.querySelector('.gv-n').textContent = shots[i].name + '  \u00b7  ' + (i + 1) + ' / ' + shots.length;
    this.root.setAttribute('data-galview', '1');
  };

  // ---------------------------------------------------------------- race passing alerts (v3.3)
  // Is this copy really on screen? (in the layout, a size, not hidden by the game or by the vehicle's-screen mode, on)
  P.passVisible = function () {
    if (this.isDash || this.destroyed || ONYX) return false;
    var r = this.root;
    if (!r || !r.isConnected || document.hidden) return false;
    if (r.getAttribute('data-off') === '1' || r.getAttribute('data-bsod') === '1' || r.getAttribute('data-dead') === '1') return false;
    var b = r.getBoundingClientRect();
    if (b.width < 40 || b.height < 30) return false;
    var W = window.innerWidth || 0, H = window.innerHeight || 0;
    if (W && H && (b.right <= 0 || b.bottom <= 0 || b.left >= W || b.top >= H)) return false;
    for (var e = r; e && e.nodeType === 1; e = e.parentElement) {
      var cs = window.getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  P.passReport = function () {
    this.lua('if TreadXLGPS and TreadXLGPS.passPresence then TreadXLGPS.passPresence(' + luaStr(this.passHandle) + ', "nav", ' + (this.passVisible() ? 'true' : 'false') + ') end');
  };
  P.renderPass = function () {
    var d = this.passData || {}, list = arr(d.alerts), b = d.btn || {};
    // the PASS button (in the screen, next to END RACE; not a bezel button)
    var pb = this.el.passBtn;
    if (pb) {
      var show = !!b.show && !ONYX && this.s.passBtn !== false;
      pb.className = 'txl-abtn passbtn' + (show ? '' : ' hidden') + (show && !b.can ? ' wait' : '');
      var lbl = b.cd ? 'PASS ' + b.cd + 's' : 'PASS';
      var tip = b.why === 'unavailable' ? 'This server has no Baja75 race alerts' : b.why === 'connecting' ? 'Connecting to the server\u2019s race alerts' : 'Ask the drivers within 100 m to let you pass';
      this.setHtml('passbtn', pb, G.pass + '<span>' + lbl + '</span>');
      pb.title = tip;
    }
    // the incoming request: newest first, the others wait under "+N more"
    var el = this.el.pass;
    var on = d.surface === 'nav' && list.length > 0 && !ONYX;
    var danger = !!(this.hud && this.hud.alert && (this.hud.alert.level === 'danger' || this.hud.alert.kind === 'dangerAhead'));
    el.className = 'txl-pass' + (on ? ' show' : '') + (on && danger ? ' low' : '') + (on && list[0].test ? ' test' : '');
    if (!on) { this.setHtml('pass', el, ''); return; }
    var a = list[0], u = this.s.units;
    var dd = typeof a.dist === 'number' ? fmtDist(a.dist, u) : null;
    var vehs = arr(a.vehs).filter(function (x) { return x && x.label; }).map(function (x) { return x.label; });
    var who = esc(a.name) + (a.num ? ' #' + esc(a.num) : '');
    var pct = a.life ? Math.max(0, Math.min(100, 100 * a.left / a.life)) : 0;
    var html = '<div class="p-h">' + (a.test ? '<b class="p-tag">TEST</b>' : '') + '<span>PASS REQUEST</span>' + (list.length > 1 ? '<i class="p-more">+' + (list.length - 1) + ' more</i>' : '') + '</div>' +
      '<div class="p-w">' + who + ' is requesting a pass</div>' +
      '<div class="p-d">' + (dd ? esc(dd.v + ' ' + dd.u) + ' away' : '') + (vehs.length ? (dd ? ' \u00b7 ' : '') + 'your ' + esc(vehs.join(', ')) : '') + '</div>' +
      (this.isDash ? '<div class="p-k">OK TO PASS: your key (Options \u203a Controls)</div>'
        : '<div class="p-b"><button class="txl-btn primary p-ok" data-act="passOk" data-v="' + esc(a.id) + '">OK TO PASS</button><button class="txl-btn p-x" data-act="passDismiss" data-v="' + esc(a.id) + '">Dismiss</button></div>') +
      '<i class="p-bar"><b style="width:' + pct.toFixed(1) + '%"></b></i>';
    this.setHtml('pass', el, html);
    // a receipt for the requester once it is really on screen here (seen is not OK TO PASS)
    if (!this.isDash && !this.passShownIds[a.id] && this.passVisible()) {
      if (++this.passShownN > 200) { this.passShownIds = {}; this.passShownN = 1; } // (kept small: the game script dedups too)
      this.passShownIds[a.id] = true;
      this.call('passShown', luaStr(a.id));
    }
  };

  // ---------------------------------------------------------------- teardown
  P.destroy = function () {
    this.destroyed = true;
    try { window.cancelAnimationFrame(this.raf); } catch (_) { }
    clearInterval(this.clockTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.mapTimer);
    clearTimeout(this.helloTimer);
    clearInterval(this.bootTimer);
    clearInterval(this.mediaTimer);
    clearTimeout(this.vctlTimer);
    clearTimeout(this.restartTimer);
    clearInterval(this.trialTimer);
    clearTimeout(this.nudgeTimer);
    clearInterval(this.passTimer);
    if (this.passTimer) this.lua('if TreadXLGPS and TreadXLGPS.passGone then TreadXLGPS.passGone(' + luaStr(this.passHandle) + ', "nav") end');
    try { window.removeEventListener('message', this.onMsg); } catch (_) { }
    try { if (this.onCsp) document.removeEventListener('securitypolicyviolation', this.onCsp); } catch (_) { }
    try { this.videoStop(); if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); } } catch (_) { }
    try { this.ro && this.ro.disconnect(); } catch (_) { }
    try { this.root.removeEventListener('click', this.onClick); } catch (_) { }
    try { document.removeEventListener('mousemove', this.onMove, true); document.removeEventListener('mouseup', this.onUp, true); } catch (_) { }
  };

  // ---------------------------------------------------------------- Angular glue
  var HOOKS = [EV + 'pass', EV + 'gallery', EV + 'hud', EV + 'list', EV + 'course', EV + 'wpts', EV + 'trail', EV + 'rec',
    EV + 'chaseTargets', EV + 'icons', EV + 'cmd', EV + 'toast', EV + 'basemap', EV + 'hello', EV + 'text', EV + 'courseInfo', EV + 'pacenoteInfo', EV + 'pacenotePreview', EV + 'runLog', EV + 'snapshot', EV + 'media', EV + 'clipboard', EV + 'videoServer', EV + 'tel', EV + 'musicArt', EV + 'videoHit', EV + 'locked', EV + 'notice', EV + 'login', EV + 'dashState'];
  TreadXLApp.HOOKS = HOOKS;

  if (window.angular && angular.module) {
    angular.module('beamng.apps').directive('treadXlNavMap', ['$injector', function ($injector) {
      // BeamNG's stream service: a global in the game's HUD page (like the stock apps use it), or an injectable
      var SM = window.StreamsManager && typeof window.StreamsManager.add === 'function' ? window.StreamsManager : null;
      if (!SM) { try { SM = $injector.has('StreamsManager') ? $injector.get('StreamsManager') : null; } catch (_) { SM = null; } }
      return {
        template: '<div class="txl-host" style="width:100%;height:100%;"></div>',
        replace: true,
        restrict: 'EA',
        scope: true,
        link: function (scope, element) {
          var app = new TreadXLApp(element[0], { lua: function (code) { bngApi.engineLua(code); } });
          element[0].__txlApp = app; // handy from the CEF devtools console
          HOOKS.forEach(function (h) { scope.$on(h, function (_, d) { app.onEvent(h, d); }); });
          scope.$on('app:resized', function () { app.resize(); });
          // Tuner mode's gauges: rpm, gear, temperatures, fuel, boost
          if (SM) {
            try { SM.add(['electrics']); } catch (_) { }
            scope.$on('streamsUpdate', function (_, streams) { if (streams && streams.electrics) { app.elx = streams.electrics; app.elxAt = Date.now(); } });
          }
          scope.$on('$destroy', function () { if (SM) { try { SM.remove(['electrics']); } catch (_) { } } app.destroy(); });
        }
      };
    }]);
  }
})();
