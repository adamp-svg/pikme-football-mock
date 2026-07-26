/*
 * Converts legacy emoji/symbol UI into the semantic Saltiz sprite pack.
 *
 * This compatibility layer lets old and newly-created DOM keep setting
 * textContent ("🤖 שלב 5", "💾 שמור", etc.) while the visible result uses the
 * new art. A MutationObserver handles client.js surfaces created after boot.
 */
(function saltizIconSystem() {
  'use strict';

  const DIRECT = new Map([
    ['⚙', 'settings'], ['📰', 'news'], ['🏅', 'rank'], ['🛒', 'shop'],
    ['👥', 'friends'], ['🏰', 'club'], ['🎮', 'arena'], ['🎯', 'training'],
    ['🏗️', 'field-builder'], ['🏗', 'field-builder'], ['✨', 'best-loadout'],
    ['📰️', 'news'], ['🃏', 'cards'], ['🎉', 'season-star'], ['🪙', 'coins'],
    ['🎁', 'gift'], ['🌟', 'season-star'], ['👕', 'skin'], ['🎟️', 'season-pass'],
    ['🎟', 'season-pass'], ['➕', 'add'], ['🔎', 'search'], ['💬', 'chat'],
    ['🥉', 'rank-bronze'], ['🥈', 'rank-silver'], ['🥇', 'rank-gold'],
    ['🔮', 'rank-platinum'], ['💣', 'bomb'], ['🌿', 'hidden'],
    ['🔊', 'sound-on'], ['🔇', 'sound-off'], ['🎵', 'music'],
    ['🎛️', 'controls-edit'], ['🎛', 'controls-edit'], ['🔒', 'lock'],
    ['👍', 'thumbs-up'], ['🔥', 'fire'], ['😂', 'laugh'], ['👋', 'hello'],
    ['🥅', 'goal-net'], ['📶', 'network'], ['⚠️', 'warning'], ['⚠', 'warning'],
    ['🌳', 'bush'], ['📦', 'crate'], ['✋', 'move-tool'], ['🩹', 'eraser'],
    ['💾', 'save'], ['🏃', 'speed'], ['🛡️', 'defense'], ['🛡', 'defense'],
    ['📐', 'field-size'], ['🤖', 'bot'], ['↶', 'undo'], ['↷', 'redo'],
    ['⇆', 'mirror-sides'], ['⇅', 'mirror-top'], ['⬛', 'square-joint'],
    ['⬤', 'round-joint'], ['↺', 'reset-ball'], ['🗑️', 'delete'],
    ['🗑', 'delete'], ['✎', 'rename'], ['▶', 'play'], ['＋', 'zoom-in'],
    ['－', 'zoom-out'], ['⭐', 'season-star'], ['🌱', 'online'],
    ['↔', 'mirror-sides'], ['↕', 'mirror-top'], ['✅', 'confirm'],
    ['✓', 'confirm'], ['✔', 'confirm'], ['❔', 'warning'],
  ]);

  const TOKENS = [
    ...DIRECT.keys(), '⚽', '🏆', '🏟️', '🏟', '💎', '⚡', '🧱', '🟫',
    '🏁', '👑', '✕', '‹', '›', '⤢',
  ].sort((a, b) => b.length - a.length);

  function within(el, selector) {
    return !!(el && el.closest && el.closest(selector));
  }

  function contextualId(token, el) {
    if (token === '⚽') {
      if (within(el, '[data-tool="ball"], .bel.ball')) return 'ball-placement';
      if (within(el, '.th-react-btn, .quick-msg, [data-qmsg]')) return 'goal-celebration';
      if (within(el, '#reset-ball-btn')) return 'reset-ball';
      return 'play';
    }
    if (token === '🏆') {
      if (within(el, '#rank, #hub-tier, .hub-tier, .rank-tier, .rank-me')) return 'rank-champion';
      if (within(el, '.th-react-btn, .quick-msg, [data-qmsg]')) return 'champion-reaction';
      return 'tournament';
    }
    if (token === '🏟️' || token === '🏟') {
      return within(el, '#th-share, .th-arena-btn, [data-share]') ? 'share-field' : 'stadium';
    }
    if (token === '💎') {
      return within(el, '#rank, #hub-tier, .rank-tier, .rank-me') ? 'rank-diamond' : 'gem';
    }
    if (token === '⚡') {
      return within(el, '#shop, .shop-cat') ? 'power' : 'power-kick';
    }
    if (token === '🧱') {
      return within(el, '#build, .build-btn, .ce-puck[data-ctl="wall"]') ? 'build-wall' : 'hard-wall';
    }
    if (token === '🟫') return 'weak-wall';
    if (token === '🏁') {
      return within(el, '.spawn-b, [data-team="b"]') ? 'spawn-blue' : 'spawn-red';
    }
    if (token === '👑') return 'rank-legend';
    if (token === '✕') {
      if (within(el, '#b-clear, .builder-clear')) return 'clear-all';
      return 'close';
    }
    if (token === '‹' || token === '›') return 'back';
    if (token === '⤢') {
      return within(el, '[data-mirror="diag"]') ? 'mirror-diagonal' : 'fit-view';
    }
    return DIRECT.get(token);
  }

  function icon(id, token) {
    const span = document.createElement('span');
    span.className = `saltiz-icon si-${id}`;
    if (token === '›') span.classList.add('si-flip');
    span.dataset.icon = id;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  function nextToken(text, from) {
    let best = null;
    let at = Infinity;
    for (const token of TOKENS) {
      const i = text.indexOf(token, from);
      if (i >= 0 && i < at) { at = i; best = token; }
    }
    return best ? { token: best, at } : null;
  }

  function replaceText(node) {
    if (!node || !node.parentElement || !node.nodeValue) return;
    const parent = node.parentElement;
    if (within(parent, 'script, style, textarea, input, select, option, canvas, .saltiz-icon')) return;

    const text = node.nodeValue;
    const first = nextToken(text, 0);
    if (!first) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let found = first;
    while (found) {
      if (found.at > cursor) fragment.append(text.slice(cursor, found.at));
      const id = contextualId(found.token, parent);
      if (id) fragment.append(icon(id, found.token));
      else fragment.append(found.token);
      cursor = found.at + found.token.length;
      found = nextToken(text, cursor);
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      replaceText(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.matches && root.matches('script, style, textarea, input, select, option, canvas, .saltiz-icon')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) replaceText(node);
  }

  function boot() {
    scan(document.body);
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === 'characterData') replaceText(change.target);
        for (const node of change.addedNodes) scan(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.SaltizIcons = { scan, icon };
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
}());
