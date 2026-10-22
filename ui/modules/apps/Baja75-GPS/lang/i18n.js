/* Baja75 Navigation Unit: languages (v3.16). Loaded by the unit, the Alerts app and the Pacenotes app.
 *
 * Each language is a file next to this one, lang/<id>.js (built from dev/lang/<id>.json by dev/build_lang.py):
 *   TXL_LANG['<id>'] = { 'English text': 'translation', ... }
 * The English text on the screen is the key. Numbers in a text become {1}, {2} ... in the key (and go back into the
 * translation in their place); {a}, {b} ... in a key stand for any text (names). A text with bold / small / line
 * breaks inside it is one key with its markup (the element's inner HTML). "A \u00b7 B" texts are also tried part by part.
 *
 * The screen is translated as it is drawn (a MutationObserver per app root), so the apps keep writing English and
 * anything without a translation simply stays English. data-noi18n on an element keeps it (and its contents) as is.
 * ASCII only (like app.js).
 */
(function () {
  'use strict';
  if (window.TXLi18n) return;

  var DIR = '/ui/modules/apps/Baja75-GPS/lang/';
  var LANGS = [
    { id: 'en', name: 'English (USA)' },
    { id: 'es-MX', name: 'Espa\u00f1ol (MXN)' },
    { id: 'de', name: 'Deutsch (GER)' },
    { id: 'ceb', name: 'Filipino (Bisaya/Cebuano)' },
    { id: 'ru', name: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439 (RU)' },
    { id: 'ja', name: '\u65e5\u672c\u8a9e (JP)' },
    { id: 'ko', name: '\ud55c\uad6d\uc5b4 (SK)' }
  ];
  var INLINE = { B: 1, I: 1, EM: 1, STRONG: 1, SMALL: 1, BR: 1, CODE: 1, U: 1, SPAN: 1, KBD: 1, SUP: 1, SUB: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, IFRAME: 1, IMG: 1 };
  var ATTRS = ['title', 'placeholder'];
  var ATTR_ONLY = { INPUT: 1, TEXTAREA: 1 }; // skipped, but their placeholder / title are translated
  var NUM = /\d+(?:[.,:]\d+)*/g;
  var DOT = ' \u00b7 ';

  var dicts = {};      // id -> { map, pats }
  var waiting = {};    // id -> [callbacks] while its file loads
  var roots = [];      // { root, lang, obs }

  function valid(id) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return id; return 'en'; }
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // numbers -> {1}, {2} ... (outside tags only, so class names and styles keep theirs)
  function numbered(s, nums) {
    return s.replace(/(<[^>]*>)|(\d+(?:[.,:]\d+)*)/g, function (m, tag, n) {
      if (tag) return tag;
      nums.push(n);
      return '{' + nums.length + '}';
    });
  }
  function fill(tr, nums, caps) {
    return tr.replace(/\{(\d+|[a-e])\}/g, function (m, k) {
      if (/\d/.test(k)) { var v = nums[Number(k) - 1]; return v == null ? m : v; }
      var c = caps && caps[k]; return c == null ? m : c;
    });
  }
  function compile(table) {
    var map = {}, pats = [];
    for (var k in table) {
      if (!Object.prototype.hasOwnProperty.call(table, k)) continue;
      var v = table[k];
      if (typeof v !== 'string' || v === '') continue;
      map[k] = v;
      if (/\{[a-e]\}/.test(k)) {
        // {a} = any text; a number's {1} matches whichever number it is on screen (a name before it may hold digits too)
        var names = [];
        var src = escRe(k).replace(/\\\{(\d+|[a-e])\\\}/g, function (m, n) { names.push(n); return /\d/.test(n) ? '(\\{\\d+\\})' : '(.+?)'; });
        pats.push({ re: new RegExp('^' + src + '$'), names: names, tr: v, len: k.length });
      }
    }
    pats.sort(function (a, b) { return b.len - a.len; });
    return { map: map, pats: pats };
  }

  // the translation of one English text (or null)
  function lookup(d, s, depth) {
    if (!d || !s) return null;
    var r = d.map[s];
    if (r != null) return r;
    var nums = [], n = numbered(s, nums);
    if (nums.length && (r = d.map[n]) != null) return fill(r, nums);
    for (var i = 0; i < d.pats.length; i++) {
      var p = d.pats[i], m = p.re.exec(n);
      if (!m) continue;
      var caps = {};
      for (var j = 0; j < p.names.length; j++) {
        var cap = fill(m[j + 1], nums), sub = !depth && cap.indexOf(DOT) > 0 ? lookup(d, cap, 0) : null; // "Opens: a \u00b7 Blocked: b"
        caps[p.names[j]] = sub != null ? sub : cap;
      }
      return p.tr.replace(/\{(\d+|[a-e])\}/g, function (x, k) { return caps[k] != null ? caps[k] : x; });
    }
    if (s.indexOf('<') >= 0) return null; // markup that isn't a key: its parts are translated one by one (walk)
    if (!depth && s.indexOf(DOT) > 0) { // "CAUTION \u00b7 JUMP", "RM 0.9 \u00b7 Pit": each part on its own
      var parts = s.split(DOT), any = false;
      for (var q = 0; q < parts.length; q++) { var t = lookup(d, parts[q], 1); if (t != null) { parts[q] = t; any = true; } }
      if (any) return parts.join(DOT);
    }
    // "\u00b7 FINISHED", "Timed runs \u00b7", "(was Tuner)": the words without the separator around them
    var e = EDGE.exec(s);
    if (e && (e[1] || e[3]) && e[2]) { var c = lookup(d, e[2], (depth || 0) + 1); if (c != null) return (e[1] || '') + c + (e[3] || ''); }
    // pacenotes ("3 RIGHT LONG TIGHTENS DON'T CUT"): capitals only, translated phrase by phrase (the longest known first)
    if (!/[a-z]/.test(s) && s.indexOf(' ') > 0) {
      var w = n.split(' '), out = [], i2 = 0;
      while (i2 < w.length) {
        if (!/[A-Z]/.test(w[i2])) { out.push(w[i2]); i2++; continue; }
        var hit = null;
        for (var len = Math.min(4, w.length - i2); len > 0 && hit == null; len--) {
          var ph = w.slice(i2, i2 + len).join(' ');
          if (len < w.length && d.map[ph] != null) { hit = d.map[ph]; i2 += len; }
        }
        if (hit == null) return null;
        out.push(hit);
      }
      return fill(out.join(' '), nums);
    }
    return null;
  }
  var EDGE = /^([\u00b7\u203a(\-]\s*)?(.*?)(\s*[\u00b7\u203a:)\-])?$/;

  // an element whose text runs through bold / small / line breaks is translated as one piece
  function isBlock(el) {
    var text = false, inline = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (/\S/.test(c.nodeValue)) text = true; }
      else if (c.nodeType === 1) { if (!INLINE[c.tagName] || c.hasAttribute('data-noi18n') || c.hasAttribute('data-act')) return false; inline = true; }
    }
    return text && inline;
  }
  function blockKey(el) { return norm(el.innerHTML); }

  function trText(st, node) {
    var cur = node.nodeValue;
    if (node.__txlOut != null && cur === node.__txlOut) return; // ours (or the app wrote what we had)
    var key = norm(cur);                                         // the app's English text
    var tr = key && /[A-Za-z]/.test(key) ? lookup(st.d, key) : null;
    if (tr == null) { node.__txlSrc = node.__txlOut = null; return; }
    var out = /^\s*/.exec(cur)[0] + tr + /\s*$/.exec(cur)[0];
    node.__txlSrc = cur;
    node.__txlOut = out;
    if (cur !== out) node.nodeValue = out;
    mark(node.parentNode);
  }
  // translated elements carry data-tr (the CSS gives Japanese / Korean text normal letter spacing there)
  function mark(el) { if (el && el.nodeType === 1 && !el.hasAttribute('data-tr')) el.setAttribute('data-tr', ''); }
  function trAttrs(st, el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute(a);
      if (v == null || v === '') continue;
      var m = el.__txlAttr || (el.__txlAttr = {}), rec = m[a];
      if (rec && rec.out === v) continue;
      var tr = lookup(st.d, norm(v));
      if (tr == null) { if (rec) rec.out = null; continue; }
      m[a] = { src: v, out: tr };
      el.setAttribute(a, tr);
    }
  }
  function walk(st, node) {
    if (!node) return;
    if (node.nodeType === 3) { trText(st, node); return; }
    if (node.nodeType !== 1 || node.hasAttribute('data-noi18n') || node.isContentEditable) return;
    if (SKIP[node.tagName]) { if (ATTR_ONLY[node.tagName]) trAttrs(st, node); return; }
    trAttrs(st, node);
    if (isBlock(node)) {
      if (node.__txlOutHtml != null && node.innerHTML === node.__txlOutHtml) return; // ours
      var key = blockKey(node), tr = lookup(st.d, key);
      if (tr != null) {
        node.__txlSrcHtml = node.innerHTML;
        node.innerHTML = tr;
        node.__txlOutHtml = node.innerHTML;
        mark(node);
        return;
      }
    }
    for (var c = node.firstChild; c; c = c.nextSibling) walk(st, c);
  }
  function inSkipped(st, node) {
    for (var n = node.nodeType === 1 ? node : node.parentNode; n && n !== st.root.parentNode; n = n.parentNode) {
      if (n.nodeType === 1 && (n.hasAttribute('data-noi18n') || SKIP[n.tagName])) return true;
    }
    return false;
  }
  function onMutations(st, list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'characterData') { if (!inSkipped(st, m.target)) trText(st, m.target); continue; }
      if (m.type === 'attributes') { if (m.target.nodeType === 1 && !inSkipped(st, ATTR_ONLY[m.target.tagName] ? m.target.parentNode : m.target)) trAttrs(st, m.target); continue; }
      var t = m.target;
      if (t.__txlOutHtml != null && t.innerHTML === t.__txlOutHtml) continue; // our own block change
      if (inSkipped(st, t)) continue;
      // a block element's children changed: the whole block again
      if (t.nodeType === 1 && isBlock(t)) { t.__txlOutHtml = null; walk(st, t); continue; }
      for (var j = 0; j < m.addedNodes.length; j++) walk(st, m.addedNodes[j]);
    }
  }
  // put every translated text of a root back to its English
  function restore(root) {
    var all = root.querySelectorAll('*');
    var undo = function (el) {
      if (el.__txlSrcHtml != null && el.innerHTML === el.__txlOutHtml) el.innerHTML = el.__txlSrcHtml;
      el.__txlSrcHtml = el.__txlOutHtml = null;
      if (el.hasAttribute && el.hasAttribute('data-tr')) el.removeAttribute('data-tr');
      if (el.__txlAttr) { for (var a in el.__txlAttr) { var r = el.__txlAttr[a]; if (r && r.out != null && el.getAttribute(a) === r.out) el.setAttribute(a, r.src); } el.__txlAttr = null; }
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 && c.__txlSrc != null) { if (c.nodeValue === c.__txlOut) c.nodeValue = c.__txlSrc; c.__txlSrc = c.__txlOut = null; }
      }
    };
    undo(root);
    for (var i = 0; i < all.length; i++) undo(all[i]);
  }

  function load(id, cb) {
    id = valid(id);
    if (id === 'en') { cb(null); return; }
    if (dicts[id]) { cb(dicts[id]); return; }
    if (waiting[id]) { waiting[id].push(cb); return; }
    waiting[id] = [cb];
    var done = function () {
      var t = window.TXL_LANG && window.TXL_LANG[id];
      if (t) dicts[id] = compile(t);
      var l = waiting[id]; waiting[id] = null;
      for (var i = 0; i < l.length; i++) { try { l[i](dicts[id] || null); } catch (e) { /* a caller's error doesn't stop the others */ } }
    };
    var s = document.createElement('script');
    s.src = DIR + id + '.js';
    s.onload = done;
    s.onerror = done;
    (document.head || document.documentElement).appendChild(s);
  }

  function stateOf(root) {
    for (var i = 0; i < roots.length; i++) if (roots[i].root === root) return roots[i];
    var st = { root: root, lang: 'en', d: null, obs: null, want: 'en' };
    roots.push(st);
    return st;
  }

  var API = {
    LANGS: LANGS,
    current: 'en',
    valid: valid,
    // translate a root (and everything drawn into it later) into a language; 'en' puts it back to English
    setLang: function (root, id, cb) {
      if (!root) return;
      id = valid(id);
      var st = stateOf(root);
      st.want = id;
      API.current = id;
      load(id, function (d) {
        if (st.want !== id) return; // another language was picked meanwhile
        if (st.obs) { st.obs.disconnect(); st.obs = null; }
        if (st.lang !== 'en') restore(root);
        st.lang = id; st.d = d;
        if (id !== 'en' && d) {
          walk(st, root);
          st.obs = new MutationObserver(function (list) { onMutations(st, list); });
          st.obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
        }
        if (cb) cb(!!d || id === 'en');
      });
    },
    // one English text in the current language (for text the apps draw outside the page, e.g. a canvas)
    t: function (s) { var d = dicts[API.current]; var r = d ? lookup(d, norm(s)) : null; return r == null ? s : r; },
    // dev: every English key a root shows right now ({ key, kind, cls }), for the catalogue (dev/build_lang.py);
    // shown = true: the texts as they are on screen (in a language: what is still English)
    collect: function (root, shown) {
      var out = [], seen = {};
      var add = function (key, kind, el) {
        key = norm(key);
        if (!key || !/[A-Za-z]{2}/.test(key)) return;
        var nums = []; key = numbered(key, nums);
        if (seen[key]) return;
        seen[key] = 1;
        var c = el, cls = '';
        while (c && c.nodeType === 1 && !cls) { cls = (c.getAttribute('class') || '').split(/\s+/)[0]; c = c.parentNode; }
        out.push({ key: key, kind: kind, cls: cls });
      };
      var go = function (node) {
        if (node.nodeType === 3) { add(node.__txlSrc != null && !shown ? node.__txlSrc : node.nodeValue, 'text', node.parentNode); return; }
        if (node.nodeType !== 1 || node.hasAttribute('data-noi18n') || (SKIP[node.tagName] && !ATTR_ONLY[node.tagName])) return;
        for (var i = 0; i < ATTRS.length; i++) { var v = node.getAttribute(ATTRS[i]); if (v) add(v, 'attr', node); }
        if (SKIP[node.tagName]) return;
        if (isBlock(node)) { add(blockKey(node), 'html', node); return; }
        for (var c = node.firstChild; c; c = c.nextSibling) go(c);
      };
      go(root);
      return out;
    },
    _lookup: function (id, s) { return lookup(dicts[id], s); }
  };
  window.TXLi18n = API;
})();
