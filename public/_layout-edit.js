/* =============================================================================
 * _layout-edit.js — DEV-ONLY visual layout edit mode for the lobby home hub.
 *
 * The home hub is authored on a fixed 900x415 logical "stage" (.hub) that
 * client.js scales uniformly to fit via a transform (fitHub). This module lets a
 * developer drag AND resize every atomic home control on that stage, then export
 * the exact box of each as {left,top,width,height} logical px (translatable to
 * CSS). Resize is a uniform transform:scale from the top-left corner, so the
 * whole box — text and icons included — scales cleanly and stays legible.
 *
 * Two responsibilities, self-gated (no game logic is touched):
 *   1. applySaved()  — runs on EVERY load. If a saved layout exists in
 *      localStorage it re-applies it, so the arrangement shows in normal view
 *      and inside the iPhone iframe (same origin). No-op when nothing is saved.
 *   2. activateEditor() — runs ONLY when the URL has ?edit=1. Draws the drag /
 *      resize handles + a fixed floating control panel and lets you export.
 *
 * Positions are stored/exported in LOGICAL stage px. Because every moved element
 * becomes a direct child of .hub with absolute left/top in that same logical
 * space, the existing scale() transform on .hub scales them for free — a drag
 * tracks the cursor 1:1 at any window size (pointer deltas are divided by the
 * live scale). Directly paste the exported values into CSS against the stage.
 * ========================================================================== */
(function () {
  'use strict';

  var HUB_W = 900, HUB_H = 415;
  var LS_KEY = 'pikme-lobby-layout';
  var PANEL_KEY = 'pikme-lobby-editor-panel'; // editor panel pos + collapsed (dev UI only)
  var snap = false; // 5px grid snap toggle (editor only)

  function q(sel, root) { return (root || document).querySelector(sel); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v) { return Math.round(v); }

  // ---- descriptors ----------------------------------------------------------
  // Every atomic box: sel = CSS selector (resolved fresh); container = the
  // stage-aligned box its left/top are relative to (default the .hub stage; the
  // 3 power slots live inside the full-stage #power-slots overlay). EVERY box is
  // draggable AND resizable (uniform transform:scale from a top-left origin).
  function descriptors() {
    return [
      { key: 'exit',       label: 'Exit',          sel: '#hub-exit' },
      { key: 'settings',   label: 'Settings',      sel: '#hub-settings' },
      { key: 'season',     label: 'Season badge',  sel: '#home .hub-season' },
      { key: 'online',     label: 'Online',        sel: '#home .hub-online' },
      { key: 'face',       label: 'Profile pic',   sel: '#home-face' },
      { key: 'name',       label: 'Player name',   sel: '#home-name' },
      { key: 'xp',         label: 'XP bar',        sel: '#home .hub-xpbar' },
      { key: 'copies',     label: 'Chip: copies',  sel: '#chip-copies' },
      { key: 'worth',      label: 'Chip: worth',   sel: '#chip-worth' },
      { key: 'cards',      label: 'Chip: cards',   sel: '#chip-cards' },
      { key: 'rank',       label: 'Collector badge', sel: '#hub-rank' },
      { key: 'news',       label: 'News',          sel: '#home .hub-sat[data-open-screen="news"]' },
      { key: 'shop',       label: 'Shop',          sel: '#home .hub-sat[data-open-screen="shop"]' },
      { key: 'friends',    label: 'Friends',       sel: '#friends-btn' },
      { key: 'clubs',      label: 'Clubs',         sel: '#home .hub-sat[data-open-screen="clubs"]' },
      { key: 'carousel',   label: 'Carousel',      sel: '#home .hub-cards' },
      { key: 'hero',       label: 'Hero',          sel: '#pick-hero-btn' },
      { key: 'slot0',      label: 'Slot 1 (בעיטה)',  sel: '#power-slots .pslot-item:nth-child(1)', container: '#power-slots' },
      { key: 'slot1',      label: 'Slot 2 (מהירות)', sel: '#power-slots .pslot-item:nth-child(2)', container: '#power-slots' },
      { key: 'slot2',      label: 'Slot 3 (הגנה)',   sel: '#power-slots .pslot-item:nth-child(3)', container: '#power-slots' },
      { key: 'quickMatch', label: 'Quick match',   sel: '#quick-match-btn' },
      { key: 'selectBest', label: 'Pick best',     sel: '#select-best-btn' },
      { key: 'playStrip',  label: 'Bottom strip',  sel: '#play-strip' }
    ];
  }
  function build() { return { hub: q('#home .hub'), list: descriptors() }; }

  function liveScale(hub) { return (hub.getBoundingClientRect().width / HUB_W) || 1; }
  function containerOf(hub, d) { return d.container ? q(d.container) : hub; }
  // Natural layout size in logical px — offsetWidth/Height ignore CSS transforms
  // (both the .hub scale and the box's own scale), so this is always the base size.
  function baseSize(el) { return { w: el.offsetWidth || 1, h: el.offsetHeight || 1 }; }

  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveLayout(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  // Editor panel UI state (position + collapsed). Defaults to COLLAPSED so the
  // lobby is fully visible/positionable first.
  function loadPanelState() {
    try {
      var v = JSON.parse(localStorage.getItem(PANEL_KEY));
      if (v && typeof v === 'object') { if (typeof v.collapsed !== 'boolean') v.collapsed = true; return v; }
    } catch (e) {}
    return { collapsed: true };
  }
  function savePanelState(obj) {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  // Pin at logical left/top within its stage-aligned container, clearing offsets.
  function placeAbsolute(container, el, left, top) {
    if (container && el.parentElement !== container) container.appendChild(el);
    el.style.position = 'absolute';
    el.style.margin = '0';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  // Uniform scale about the top-left corner so left/top stays the anchor and the
  // WHOLE box (text + icons) scales cleanly and stays legible. The resize handle is
  // counter-scaled so it stays a constant, easy-to-grab size at any box scale.
  function applyScale(el, scale) {
    el.style.transformOrigin = '0 0';
    el.style.transform = Math.abs(scale - 1) < 1e-4 ? 'none' : ('scale(' + scale + ')');
    var h = el.querySelector && el.querySelector('.le-resize');
    if (h) h.style.transform = 'scale(' + (1 / scale) + ')';
  }

  function sizeOf(d, st) { return { w: round(d._baseW * st.scale), h: round(d._baseH * st.scale) }; }

  function exportObj(list, state) {
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var d = list[i], st = state[d.key]; if (!st) continue;
      var sz = sizeOf(d, st);
      out[d.key] = { left: round(st.left), top: round(st.top), width: sz.w, height: sz.h };
    }
    return out;
  }

  // ---- APPLY (every load) ----------------------------------------------------
  function applySaved() {
    var built = build();
    if (!built.hub) return;
    var layout = loadLayout();
    if (!layout || !Object.keys(layout).length) return;
    var hub = built.hub;
    for (var i = 0; i < built.list.length; i++) {
      var d = built.list[i], v = layout[d.key];
      if (!v || typeof v.left !== 'number') continue;
      var el = q(d.sel); if (!el) continue;
      placeAbsolute(containerOf(hub, d), el, v.left, v.top);
      if (typeof v.width === 'number') {
        var b = baseSize(el);
        if (b.w) applyScale(el, v.width / b.w);
      }
    }
  }

  // ---- EDITOR (?edit=1 only) -------------------------------------------------
  var panelRows = {}; // key -> row element (for live readouts)

  function fmt(d, st) {
    var sz = sizeOf(d, st);
    return 'x ' + round(st.left) + ' · y ' + round(st.top) + ' · w ' + sz.w + ' · h ' + sz.h;
  }

  function updateRow(d, st) {
    var row = panelRows[d.key];
    if (row) row.querySelector('.le-vals').textContent = fmt(d, st);
  }

  function activateEditor() {
    var built = build();
    var hub = built.hub;
    if (!hub) { console.warn('[layout-edit] no #home .hub found — editor not activated'); return; }

    var layout = loadLayout();
    var scale = liveScale(hub);
    var state = {};
    var list = [];

    // Pass 1: resolve each box, capture its base size + current logical position
    // (relative to its container) BEFORE anything moves.
    var all = built.list;
    for (var i = 0; i < all.length; i++) {
      var d = all[i], el = q(d.sel);
      if (!el) continue; // element not present -> skip
      d._el = el;
      d._container = containerOf(hub, d);
      var b = baseSize(el); d._baseW = b.w; d._baseH = b.h;
      var saved = layout[d.key], st;
      if (saved && typeof saved.left === 'number') {
        st = { left: saved.left, top: saved.top, scale: (typeof saved.width === 'number' && b.w) ? saved.width / b.w : 1 };
      } else {
        var cr = d._container.getBoundingClientRect(), er = el.getBoundingClientRect();
        st = { left: (er.left - cr.left) / scale, top: (er.top - cr.top) / scale, scale: 1 };
      }
      state[d.key] = st;
      list.push(d);
    }

    // Pass 2: apply + wire drag / resize on every box.
    injectStyle();
    for (var j = 0; j < list.length; j++) {
      var dd = list[j], stt = state[dd.key];
      placeAbsolute(dd._container, dd._el, stt.left, stt.top);
      applyScale(dd._el, stt.scale);
      dd._el.classList.add('le-movable');
      attachDrag(hub, dd, state);
      attachResize(hub, dd, state);
      dd._el.addEventListener('click', swallow, true); // block the control's own click while editing
    }
    currentList = list;
    persist(list, state);
    buildPanel(list, state);
    console.log('[layout-edit] edit mode ON — every box drags + resizes. Then "Copy layout".');
  }

  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  function persist(list, state) { saveLayout(exportObj(list, state)); }

  function attachDrag(hub, d, state) {
    var el = d._el;
    el.addEventListener('pointerdown', function (e) {
      if (e.target.classList && e.target.classList.contains('le-resize')) return; // resize owns this
      e.preventDefault(); e.stopPropagation();
      var vs = liveScale(hub);
      var st = state[d.key];
      var startX = e.clientX, startY = e.clientY, startL = st.left, startT = st.top;
      var w = d._baseW * st.scale, h = d._baseH * st.scale;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add('le-dragging');
      function mv(ev) {
        var nl = startL + (ev.clientX - startX) / vs;
        var nt = startT + (ev.clientY - startY) / vs;
        nl = clamp(nl, 0, Math.max(0, HUB_W - w));
        nt = clamp(nt, 0, Math.max(0, HUB_H - h));
        if (snap) { nl = Math.round(nl / 5) * 5; nt = Math.round(nt / 5) * 5; }
        st.left = round(nl); st.top = round(nt);
        el.style.left = st.left + 'px'; el.style.top = st.top + 'px';
        updateRow(d, st);
      }
      function up() {
        el.classList.remove('le-dragging');
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        persist(currentList, state);
      }
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  function attachResize(hub, d, state) {
    var el = d._el;
    var handle = document.createElement('div');
    handle.className = 'le-resize';
    handle.title = 'drag to resize';
    // A box that clips (scroll strip) would hide a corner handle hanging outside it — inset it.
    var ov = getComputedStyle(el);
    if (/(auto|scroll|hidden)/.test(ov.overflowX + ' ' + ov.overflowY)) handle.classList.add('le-inset');
    el.appendChild(handle);
    handle.style.transform = 'scale(' + (1 / (state[d.key].scale || 1)) + ')'; // constant screen size
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var vs = liveScale(hub);
      var st = state[d.key];
      var startX = e.clientX, startY = e.clientY, startScale = st.scale;
      var maxScale = Math.min(HUB_W / d._baseW, HUB_H / d._baseH);
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        var dx = (ev.clientX - startX) / vs, dy = (ev.clientY - startY) / vs;
        var ns = startScale + (dx / d._baseW + dy / d._baseH) / 2; // uniform: average the two axes
        if (snap) { var w = Math.round(d._baseW * ns / 5) * 5; ns = w / d._baseW; }
        ns = clamp(ns, 0.25, maxScale);
        st.scale = ns;
        applyScale(el, ns);
        updateRow(d, st);
      }
      function up() {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        persist(currentList, state);
      }
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  var currentList = null;

  function buildPanel(list, state) {
    currentList = list;
    var panel = document.createElement('div');
    panel.id = 'le-panel';
    var html = '<div class="le-head" id="le-head" title="drag to move">' +
      '<span class="le-title">⚙ layout</span>' +
      '<span class="le-badge">?edit=1</span>' +
      '<button class="le-toggle" id="le-toggle" title="collapse / expand">▸</button></div>';
    html += '<div class="le-body" id="le-body">';
    html += '<div class="le-rows">';
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      html += '<div class="le-row" data-k="' + d.key + '">' +
        '<div class="le-name">' + d.label + ' <em>⤢</em></div>' +
        '<div class="le-vals">' + fmt(d, state[d.key]) + '</div></div>';
    }
    html += '</div>';
    html += '<label class="le-snap"><input type="checkbox" id="le-snap-cb"> 5px grid snap</label>';
    html += '<div class="le-btns">' +
      '<button id="le-copy">Copy layout</button>' +
      '<button id="le-reset">Reset</button>' +
      '<button id="le-exit">Exit</button></div>';
    html += '</div>'; // /.le-body
    panel.innerHTML = html;
    document.body.appendChild(panel);

    var rows = panel.querySelectorAll('.le-row');
    for (var r = 0; r < rows.length; r++) panelRows[rows[r].getAttribute('data-k')] = rows[r];

    // ---- collapse / expand (default collapsed) + drag-to-move + persistence ----
    var pstate = loadPanelState();
    function applyCollapsed() {
      panel.classList.toggle('le-collapsed', !!pstate.collapsed);
      var tog = panel.querySelector('#le-toggle');
      tog.textContent = pstate.collapsed ? '▸' : '▾';
      tog.title = pstate.collapsed ? 'expand' : 'collapse';
    }
    function clampPanel(left, top) {
      var pr = panel.getBoundingClientRect();
      var w = pr.width || 60, h = pr.height || 30;
      return {
        left: clamp(left, 4, Math.max(4, window.innerWidth - w - 4)),
        top: clamp(top, 4, Math.max(4, window.innerHeight - h - 4))
      };
    }
    function applyPanelPos() {
      // default dock: bottom-LEFT (low-conflict) if no saved position.
      var left = (typeof pstate.left === 'number') ? pstate.left : 12;
      var top = (typeof pstate.top === 'number') ? pstate.top : (window.innerHeight - 46);
      var c = clampPanel(left, top);
      panel.style.left = c.left + 'px';
      panel.style.top = c.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    applyCollapsed();
    applyPanelPos();

    panel.querySelector('#le-toggle').addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    panel.querySelector('#le-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      pstate.collapsed = !pstate.collapsed;
      applyCollapsed();
      // re-clamp so an expanded panel near an edge stays on-screen
      var pr = panel.getBoundingClientRect();
      var c = clampPanel(pr.left, pr.top);
      panel.style.left = c.left + 'px'; panel.style.top = c.top + 'px';
      pstate.left = c.left; pstate.top = c.top;
      savePanelState(pstate);
    });

    // drag the panel by its header
    var head = panel.querySelector('#le-head');
    head.addEventListener('pointerdown', function (e) {
      if (e.target.id === 'le-toggle') return;
      e.preventDefault();
      var pr = panel.getBoundingClientRect();
      var ox = e.clientX - pr.left, oy = e.clientY - pr.top;
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      head.classList.add('le-headdrag');
      function mv(ev) {
        var c = clampPanel(ev.clientX - ox, ev.clientY - oy);
        panel.style.left = c.left + 'px'; panel.style.top = c.top + 'px';
        pstate.left = c.left; pstate.top = c.top;
      }
      function up() {
        head.classList.remove('le-headdrag');
        head.removeEventListener('pointermove', mv);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        savePanelState(pstate);
      }
      head.addEventListener('pointermove', mv);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });

    panel.querySelector('#le-snap-cb').addEventListener('change', function (e) { snap = e.target.checked; });
    panel.querySelector('#le-copy').addEventListener('click', function () {
      var obj = exportObj(list, state);
      var json = JSON.stringify(obj, null, 2);
      console.log('[layout-edit] layout (logical px against the 900x415 stage):\n' + json);
      console.log(obj);
      var done = function () { flash(this_copy, 'Copied!'); };
      var this_copy = panel.querySelector('#le-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(done, function () { fallbackCopy(json); done(); });
      } else { fallbackCopy(json); done(); }
    });
    panel.querySelector('#le-reset').addEventListener('click', function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      location.reload();
    });
    panel.querySelector('#le-exit').addEventListener('click', function () {
      // leave the editor but keep the saved layout; reload without ?edit
      var url = new URL(location.href);
      url.searchParams.delete('edit');
      location.href = url.toString();
    });
  }

  function flash(btn, txt) {
    var old = btn.textContent; btn.textContent = txt;
    setTimeout(function () { btn.textContent = old; }, 1100);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }

  function injectStyle() {
    if (q('#le-style')) return;
    var css = '' +
      '.le-movable{outline:1px dashed rgba(255,203,67,.75);outline-offset:2px;cursor:grab;touch-action:none;}' +
      '.le-movable.le-dragging{outline-color:#57e08a;cursor:grabbing;}' +
      '.le-resize{position:absolute;right:-11px;bottom:-11px;width:26px;height:26px;' +
        'display:flex;align-items:center;justify-content:center;transform-origin:100% 100%;' +
        'background:#ffcb43;color:#2a1c05;font:900 15px system-ui,sans-serif;line-height:1;' +
        'border:2px solid #2a1c05;border-radius:6px;cursor:nwse-resize;z-index:100;' +
        'touch-action:none;box-shadow:0 2px 7px rgba(0,0,0,.7);}' +
      '.le-resize.le-inset{right:3px;bottom:3px;}' + /* for clipping boxes (scroll strip) */
      '.le-resize::after{content:"\\2921";}' + /* ⤡ diagonal resize glyph */
      '.le-resize:hover{background:#ffdd6e;}' +
      '.le-movable:hover>.le-resize{box-shadow:0 0 0 2px rgba(87,224,138,.6),0 2px 7px rgba(0,0,0,.7);}' +
      '#le-panel{position:fixed;z-index:2147483647;width:210px;max-height:92vh;overflow:hidden auto;' +
        'font:12px/1.4 system-ui,sans-serif;color:#e9f0e6;background:rgba(14,20,15,.96);border:1px solid #46543f;' +
        'border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);padding:8px;direction:ltr;pointer-events:auto;}' +
      '#le-panel.le-collapsed{width:auto;overflow:visible;padding:0;}' +
      '#le-panel.le-collapsed .le-body{display:none;}' +
      '#le-panel .le-head{font-weight:800;font-size:13px;display:flex;align-items:center;gap:7px;' +
        'cursor:move;user-select:none;touch-action:none;padding:5px 7px;border-radius:7px;}' +
      '#le-panel .le-head.le-headdrag{background:rgba(255,203,67,.14);}' +
      '#le-panel.le-collapsed .le-head{background:rgba(255,203,67,.12);}' +
      '#le-panel:not(.le-collapsed) .le-head{margin-bottom:8px;}' +
      '#le-panel .le-title{white-space:nowrap;}' +
      '#le-panel .le-toggle{margin-left:auto;cursor:pointer;font:800 12px system-ui,sans-serif;line-height:1;' +
        'color:#0e140f;background:#cdd8c8;border:0;border-radius:5px;padding:3px 7px;}' +
      '#le-panel .le-badge{font-size:9px;font-weight:700;color:#2a1c05;background:#ffcb43;padding:2px 6px;border-radius:6px;}' +
      '#le-panel .le-rows{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}' +
      '#le-panel .le-row{background:rgba(255,255,255,.04);border:1px solid #2a352c;border-radius:6px;padding:5px 7px;}' +
      '#le-panel .le-name{font-weight:700;color:#cde0c6;}' +
      '#le-panel .le-name em{color:#ffcb43;font-style:normal;}' +
      '#le-panel .le-vals{font-variant-numeric:tabular-nums;color:#9fb0a2;font-size:11px;margin-top:2px;}' +
      '#le-panel .le-snap{display:flex;align-items:center;gap:6px;margin-bottom:10px;color:#cdd8c8;user-select:none;}' +
      '#le-panel .le-btns{display:flex;gap:6px;}' +
      '#le-panel .le-btns button{flex:1;cursor:pointer;font:700 11px system-ui,sans-serif;color:#0e140f;' +
        'background:#cdd8c8;border:0;border-radius:6px;padding:8px 4px;}' +
      '#le-panel #le-copy{background:#ffcb43;}' +
      '#le-panel #le-exit{background:#8fb08a;}';
    var s = document.createElement('style');
    s.id = 'le-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  // ---- boot ------------------------------------------------------------------
  function boot() {
    var edit = /[?&]edit=1(?:&|$)/.test(location.search);
    // rAF so client.js has finished fitHub() and initial layout before we measure.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (edit) activateEditor();
        else applySaved();
      });
    });
  }

  // Expose the layout re-apply so client.js can restore positions after it re-renders
  // dynamic children (e.g. renderPowerSlots wipes #power-slots on equip).
  window.__lobbyApplyLayout = applySaved;

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
