/*
 * LLM Context Harvester — ISOLATED world orchestrator.
 *
 * Loaded first in the ISOLATED content script; the platform adapters (src/adapters/*.js)
 * load right after it and register themselves on the shared `globalThis.__LCH__` namespace.
 * Content scripts listed in one manifest entry share the same isolated global scope,
 * which is how these files cooperate without ES modules or a bundler.
 *
 * Responsibilities:
 *  - Messaging with the popup (start / abort / status / result) + live progress log.
 *  - MAIN-world bridge (CustomEvent with JSON string payloads).
 *  - Shared DOM sweep utilities (history loading, kinematic scroll, toggle expansion,
 *    ordered de-duplicated turn collection).
 *  - DOM -> elements serializer (code, Mermaid, SVG, KaTeX, tables, ASCII diagrams).
 *  - Unified JSON + Markdown builders.
 */
(() => {
  'use strict';

  const LCH = (globalThis.__LCH__ = globalThis.__LCH__ || { adapters: {} });
  // Re-injection (popup fallback, extension reload): tear down the previous instance.
  try {
    if (typeof LCH.dispose === 'function') LCH.dispose();
  } catch {
    /* previous instance already gone */
  }

  const VERSION = '1.1.0';

  /* ------------------------------------------------------------------ */
  /* Generic helpers                                                     */
  /* ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const PLATFORMS = [
    { id: 'claude', label: 'Claude', test: (h) => h === 'claude.ai' },
    { id: 'gemini', label: 'Gemini', test: (h) => h === 'gemini.google.com' },
    { id: 'meta-ai', label: 'Meta AI', test: (h) => h === 'www.meta.ai' || h === 'meta.ai' },
  ];

  const detectPlatform = (host = location.hostname) => PLATFORMS.find((p) => p.test(host)) || null;

  const hashString = (str) => {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  const cleanText = (t) =>
    String(t || '')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const shortText = (el, max = 140) => {
    const t = ((el && (el.getAttribute && el.getAttribute('aria-label'))) || '') + ' ' + ((el && el.textContent) || '');
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
  };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
    zsh: 'bash', ps1: 'powershell', sql: 'sql', html: 'html', htm: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown', markdown: 'markdown',
    svg: 'svg', mmd: 'mermaid', mermaid: 'mermaid', csv: 'csv', txt: 'text', r: 'r', lua: 'lua',
    dart: 'dart', vue: 'vue', svelte: 'svelte', tex: 'latex', ipynb: 'json', dockerfile: 'dockerfile',
  };

  const langFromFilename = (name) => {
    const base = String(name || '').split('/').pop().toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    return EXT_LANG[ext] || ext || '';
  };

  const normalizeLang = (lang) => {
    const l = String(lang || '').trim().toLowerCase().replace(/\s+/g, '');
    const map = { 'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', shell: 'bash', sh: 'bash', js: 'javascript', ts: 'typescript', py: 'python', plaintext: 'text', 'plain-text': 'text', txt: 'text' };
    return map[l] || l;
  };

  const MERMAID_RE = /^(%%\{[\s\S]*?\}%%\s*)?(graph\s+(TB|TD|BT|RL|LR)|flowchart(\s+(TB|TD|BT|RL|LR))?|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|gantt|pie(\s+showData)?|journey|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|xychart-beta|sankey-beta|block-beta|packet-beta|architecture-beta|kanban)\b/;
  const BOX_RE = /[─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬▲▼◀▶►◄→←↑↓]|(\+[-=]{3,}\+)|(\|[ \t]{2,}\S.*\|)/;

  const REASONING_TOGGLE_RE = /((afficher|voir|show|view|display|expand)\s+(la\s+|le\s+|les\s+|the\s+)?(réflexion|raisonnement|pensées|thinking|thoughts?|reasoning))|(thought\s+for)|(reasoned\s+for)|(réflexion\s+(terminée|pendant))|(a\s+réfléchi)|(thought\s+process)|(processus\s+de\s+réflexion)/i;

  /* ------------------------------------------------------------------ */
  /* DOM -> elements serializer                                          */
  /* ------------------------------------------------------------------ */

  class Sink {
    constructor() {
      this.items = [];
      this.buf = '';
    }
    atLineStart() {
      return this.buf === '' || this.buf.endsWith('\n');
    }
    text(s, pre = false) {
      if (!s) return;
      let t = String(s);
      if (!pre) {
        t = t.replace(/\s+/g, ' ');
        if (this.atLineStart()) t = t.replace(/^ +/, '');
        else if (this.buf.endsWith(' ')) t = t.replace(/^ +/, '');
      }
      if (t) this.buf += t;
    }
    raw(s) {
      if (s) this.buf += s;
    }
    breakLine(n = 1) {
      if (!this.buf) return;
      this.buf = this.buf.replace(/[ \t]+$/, '');
      const have = (this.buf.match(/\n*$/) || [''])[0].length;
      if (have < n) this.buf += '\n'.repeat(n - have);
    }
    block(item) {
      this.flush();
      if (item && item.payload != null && String(item.payload).trim()) this.items.push(item);
    }
    flush() {
      if (this.buf.trim()) this.items.push({ kind: 'text', payload: this.buf });
      this.buf = '';
    }
    finish() {
      this.flush();
      return this.items;
    }
  }

  const fenceFor = (content) => {
    const runs = String(content).match(/`+/g) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
    return '`'.repeat(longest + 1);
  };

  const fenced = (content, lang = '') => {
    const body = String(content).replace(/\n+$/, '');
    const f = fenceFor(body);
    return `${f}${lang || ''}\n${body}\n${f}`;
  };

  /** Markdown for one element (used by the Markdown builder and nested renders). */
  function renderElementMd(e) {
    if (!e) return '';
    switch (e.kind) {
      case 'text':
      case 'table':
        return e.payload;
      case 'code':
        return `${e.title ? `**${e.title}**\n\n` : ''}${fenced(e.payload, e.language)}`;
      case 'mermaid':
        return fenced(e.payload, 'mermaid');
      case 'svg':
        return fenced(e.payload, 'svg');
      case 'artifact':
        return fenced(e.payload, e.language || '');
      default:
        return String(e.payload || '');
    }
  }

  const itemsToMarkdown = (items) => (items || []).map(renderElementMd).filter((s) => s && s.trim()).join('\n\n');

  const finalizeItems = (items) => {
    const out = [];
    for (const it of items) {
      if (it.kind === 'text') {
        const payload = cleanText(it.payload);
        if (!payload) continue;
        const prev = out[out.length - 1];
        if (prev && prev.kind === 'text' && (prev.origin || 'inline') === (it.origin || 'inline') && !prev.isReference && !it.isReference) {
          prev.payload = `${prev.payload}\n\n${payload}`;
        } else {
          out.push({ ...it, payload });
        }
      } else {
        out.push(it);
      }
    }
    return out;
  };

  const DEFAULT_SKIP = [
    '[hidden]',
    '[aria-hidden="true"]',
    '.sr-only',
    '.cdk-visually-hidden',
    '.visually-hidden',
    '[role="button"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="tooltip"]',
    '[role="toolbar"]',
    '[contenteditable="true"]',
  ].join(',');

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'input', 'textarea', 'select', 'option', 'button',
    'link', 'meta', 'head', 'canvas', 'object', 'embed', 'dialog', 'mat-icon', 'gem-icon', 'path',
  ]);

  const BLOCK_TAGS = new Set([
    'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption',
    'address', 'fieldset', 'form', 'center',
  ]);

  const KNOWN_CODE_WRAPPERS = 'code-block, .ur-code-block, .code-block';

  const validSelector = (sel) => {
    if (!sel) return '';
    try {
      document.createDocumentFragment().querySelector(sel);
      return sel;
    } catch {
      return '';
    }
  };

  /**
   * Map code-block containers to the <pre> elements they hold, so that their chrome
   * (language label, copy button, "Run"/"Output" headers) is never emitted as text.
   * Known wrappers may hold several <pre> (Gemini: code + execution output).
   */
  function indexCodeWrappers(root) {
    const map = new Map();
    let pres = [];
    try {
      pres = root.querySelectorAll ? [...root.querySelectorAll('pre')] : [];
    } catch {
      return map;
    }
    for (const pre of pres) {
      try {
        const known = pre.closest(KNOWN_CODE_WRAPPERS);
        if (known && known !== root && root.contains(known)) {
          if (!map.has(known)) map.set(known, []);
          map.get(known).push(pre);
          continue;
        }
        let best = null;
        let el = pre.parentElement;
        for (let i = 0; i < 3 && el && el !== root; i++, el = el.parentElement) {
          if (el.querySelectorAll('pre').length !== 1) break;
          if (/^(p|li|td|th|blockquote|ul|ol|table|details)$/i.test(el.localName)) break;
          const prose = [...el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, table')].some((n) => !pre.contains(n));
          if (prose) break;
          const extra = (el.textContent || '').length - (pre.textContent || '').length;
          if (extra > 40) break;
          best = el;
        }
        if (best) map.set(best, [pre]);
      } catch {
        /* ignore this pre */
      }
    }
    return map;
  }

  /** Nearest header-like sibling before `pre` inside `wrapper` (per-<pre> language label). */
  function headerBefore(pre, wrapper) {
    for (let node = pre; node && node !== wrapper; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.localName === 'pre' || sib.querySelector('pre')) return null;
        if ((sib.textContent || '').trim()) return sib;
      }
    }
    return null;
  }

  const isExecutionOutput = (pre) =>
    !!pre.querySelector('[data-test-id*="output"], [class*="code-result"], [class*="output"]') || /output|result/i.test(pre.className || '');

  function codeLanguage(pre, wrapper) {
    const code = pre.querySelector('code');
    for (const c of [code, pre, wrapper]) {
      if (!c) continue;
      for (const cls of c.classList || []) {
        const m = cls.match(/^(?:language|lang)-(.+)$/i);
        if (m) return normalizeLang(m[1]);
      }
      const dl = c.getAttribute && (c.getAttribute('data-language') || c.getAttribute('data-lang') || c.getAttribute('data-code-language'));
      if (dl) return normalizeLang(dl);
    }
    if (!wrapper) return '';
    const preferred = wrapper.querySelector('.code-block-decoration span, .ur-code-block__metadata, [data-code-language], [class*="code-lang"], [class*="language-label"]');
    const candidates = preferred ? [preferred] : [];
    for (const el of wrapper.querySelectorAll('span, div, p, small, label')) {
      if (el.children.length === 0 && !pre.contains(el)) candidates.push(el);
    }
    for (const el of candidates) {
      if (pre.contains(el) || el.closest('button, [role="button"]')) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      if (/^(copy|copier|copié|copied|download|télécharger|code)\b/i.test(t) || /^\d+\s+lines?$/i.test(t)) continue;
      return normalizeLang(t);
    }
    return '';
  }

  function codeToElement(text, lang) {
    const body = String(text || '').replace(/\n+$/, '');
    if (!body.trim()) return null;
    const l = normalizeLang(lang);
    if (l === 'mermaid' || (!l && MERMAID_RE.test(body.trim()))) return { kind: 'mermaid', payload: body, language: 'mermaid' };
    if ((l === 'svg' || l === 'xml' || l === 'html') && /^\s*<svg[\s>]/i.test(body) && /<\/svg>\s*$/i.test(body)) {
      return { kind: 'svg', payload: body.trim(), language: 'svg' };
    }
    if (!l && BOX_RE.test(body)) return { kind: 'code', payload: body, language: 'text' };
    return { kind: 'code', payload: body, language: l || undefined };
  }

  function handleCode(pre, wrapper, sink) {
    const code = pre.querySelector('code') || pre;
    const el = codeToElement(code.textContent || '', codeLanguage(pre, wrapper));
    if (el) sink.block(el);
  }

  function handleCodeWrapper(wrapper, pres, sink) {
    for (const pre of pres) {
      if (isExecutionOutput(pre)) {
        const text = (pre.textContent || '').replace(/\n+$/, '');
        if (text.trim()) sink.block({ kind: 'code', payload: text, language: 'text', title: 'Execution output' });
        continue;
      }
      handleCode(pre, pres.length > 1 ? headerBefore(pre, wrapper) : wrapper, sink);
    }
  }

  function emitTex(sink, tex, display) {
    const t = String(tex || '').trim();
    if (!t) return;
    if (display) {
      sink.breakLine(2);
      sink.raw(`$$\n${t}\n$$`);
      sink.breakLine(2);
    } else {
      if (!sink.atLineStart() && !sink.buf.endsWith(' ') && /[\w)]$/.test(sink.buf)) sink.raw(' ');
      sink.raw(`$${t}$`);
    }
  }

  /** Math: KaTeX annotation, Gemini data-math, MathML, MathJax. Never raw .katex textContent. */
  function handleMath(el, sink) {
    if (el.hasAttribute('data-math')) {
      const tex = el.getAttribute('data-math');
      if (tex && tex.trim()) {
        const display = el.classList.contains('math-block') || el.classList.contains('math-display');
        emitTex(sink, tex, display);
        return true;
      }
    }
    const cl = el.classList;
    if (cl && (cl.contains('katex-display') || cl.contains('katex'))) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      const display = cl.contains('katex-display') || !!el.closest('.katex-display, .math-block, .math-display');
      if (ann) {
        emitTex(sink, ann.textContent, display);
        return true;
      }
      const mathml = el.querySelector('.katex-mathml');
      if (mathml) {
        sink.text(mathml.textContent);
        return true;
      }
    }
    if (el.localName === 'math') {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      emitTex(sink, ann ? ann.textContent : el.textContent, el.getAttribute('display') === 'block');
      return true;
    }
    if (el.localName === 'mjx-container') {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (ann && ann.textContent) || el.getAttribute('data-latex') || el.getAttribute('aria-label');
      if (tex) {
        emitTex(sink, tex, el.getAttribute('display') === 'true');
        return true;
      }
    }
    return false;
  }

  /** Mermaid containers that still carry their source. */
  function handleMermaidContainer(el, sink) {
    const src =
      el.getAttribute('data-source') ||
      el.getAttribute('data-mermaid-source') ||
      el.getAttribute('data-mermaid') ||
      el.getAttribute('data-code') ||
      '';
    if (src && MERMAID_RE.test(src.trim())) {
      sink.block({ kind: 'mermaid', payload: src.trim(), language: 'mermaid' });
      return true;
    }
    if (el.classList && el.classList.contains('mermaid') && !el.querySelector('svg')) {
      const t = (el.textContent || '').trim();
      if (MERMAID_RE.test(t)) {
        sink.block({ kind: 'mermaid', payload: t, language: 'mermaid' });
        return true;
      }
    }
    return false;
  }

  function handleSvg(el, sink) {
    if (el.closest('button, [role="button"], a')) return;
    const rect = el.getBoundingClientRect();
    let w = rect.width;
    let h = rect.height;
    if (!w && !h) {
      const vb = el.viewBox && el.viewBox.baseVal;
      w = parseFloat(el.getAttribute('width')) || (vb && vb.width) || 0;
      h = parseFloat(el.getAttribute('height')) || (vb && vb.height) || 0;
    }
    const size = Math.max(w, h);
    if (size > 0 && size < 24) return;
    const shapes = el.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text, foreignObject, use').length;
    if (size <= 50 && shapes < 5) return;
    const payload = new XMLSerializer().serializeToString(el);
    const titleEl = el.querySelector('title');
    const title = el.getAttribute('aria-label') || (titleEl && titleEl.textContent.trim()) || undefined;
    sink.block({ kind: 'svg', payload, title, language: 'svg' });
  }

  /** Absolute URL, with outbound redirect wrappers removed (l.meta.ai/?u=…, google.com/url?q=…). */
  function cleanUrl(href) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return href;
    }
    try {
      if (/^(l|lm)\.(meta\.ai|facebook\.com|instagram\.com|messenger\.com|threads\.(net|com))$/i.test(u.hostname)) {
        const target = u.searchParams.get('u');
        if (target && /^https?:/i.test(target)) return target;
      }
      if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/url') {
        const target = u.searchParams.get('q') || u.searchParams.get('url');
        if (target && /^https?:/i.test(target)) return target;
      }
    } catch {
      /* keep the original */
    }
    return u.href;
  }

  const absUrl = cleanUrl;

  /** Text shown with white-space: pre / pre-wrap / pre-line keeps its line breaks (e.g. Meta prompts). */
  function preservesBreaks(el, ctx) {
    if (!el) return null;
    if (!ctx.wsCache) ctx.wsCache = new Map();
    if (!ctx.wsCache.has(el)) {
      let mode = null;
      try {
        const ws = getComputedStyle(el).whiteSpace;
        if (/^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws)) mode = ws;
      } catch {
        mode = null;
      }
      ctx.wsCache.set(el, mode);
    }
    return ctx.wsCache.get(el);
  }

  function renderSub(nodes, ctx) {
    const sub = new Sink();
    for (const n of nodes) walk(n, sub, ctx);
    return sub.finish();
  }

  function inlineString(el, ctx) {
    return itemsToMarkdown(renderSub(childNodesOf(el), ctx));
  }

  function wrapInline(el, sink, ctx, left, right = left) {
    const s = inlineString(el, ctx).trim();
    const raw = el.textContent || '';
    if (!s) return;
    if (/^\s/.test(raw) && !sink.atLineStart() && !sink.buf.endsWith(' ')) sink.raw(' ');
    sink.raw(`${left}${s}${right}`);
    if (/\s$/.test(raw)) sink.raw(' ');
  }

  function handleTable(table, sink, ctx) {
    const rows = [...table.rows];
    if (!rows.length) return;
    const matrix = rows.map((r) => {
      const cells = [];
      for (const c of r.cells) {
        const txt = itemsToMarkdown(renderSub(childNodesOf(c), ctx))
          .replace(/\|/g, '\\|')
          .replace(/\s*\n+\s*/g, '<br>')
          .trim();
        cells.push(txt);
        const span = Math.min(parseInt(c.colSpan, 10) || 1, 20);
        for (let i = 1; i < span; i++) cells.push('');
      }
      return cells;
    });
    const cols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    if (!cols) return;
    const pad = (r) => r.concat(Array(cols - r.length).fill(''));
    const line = (r) => `| ${pad(r).join(' | ')} |`;
    const out = [line(matrix[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...matrix.slice(1).map(line)];
    sink.block({ kind: 'table', payload: out.join('\n') });
  }

  function handleList(el, sink, ctx) {
    const ordered = el.localName === 'ol';
    let n = parseInt(el.getAttribute('start') || '1', 10);
    if (!Number.isFinite(n)) n = 1;
    sink.breakLine(ctx.listDepth ? 1 : 2);
    for (const li of el.children) {
      if (li.localName !== 'li') {
        walk(li, sink, ctx);
        continue;
      }
      const marker = ordered ? `${n++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      const items = renderSub(childNodesOf(li), { ...ctx, listDepth: (ctx.listDepth || 0) + 1 });
      let first = true;
      for (const it of items) {
        if (it.kind === 'text') {
          const t = cleanText(it.payload).replace(/\n{2,}/g, '\n');
          if (!t) continue;
          sink.breakLine(1);
          sink.raw(t.split('\n').map((ln, i) => (first && i === 0 ? marker : pad) + ln).join('\n'));
          sink.breakLine(1);
        } else {
          if (first) {
            sink.breakLine(1);
            sink.raw(marker.trimEnd());
          }
          sink.block(it);
        }
        first = false;
      }
    }
    sink.breakLine(ctx.listDepth ? 1 : 2);
  }

  function handleBlockquote(el, sink, ctx) {
    const items = renderSub(childNodesOf(el), ctx);
    sink.breakLine(2);
    for (const it of items) {
      if (it.kind === 'text') {
        const t = cleanText(it.payload);
        if (!t) continue;
        sink.raw(t.split('\n').map((ln) => (ln ? `> ${ln}` : '>')).join('\n'));
        sink.breakLine(2);
      } else {
        sink.block(it);
      }
    }
    sink.breakLine(2);
  }

  function childNodesOf(el) {
    if (!el) return [];
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (el.shadowRoot && el.shadowRoot.childNodes.length) return [...el.shadowRoot.childNodes];
    return [...el.childNodes];
  }

  function walkChildren(el, sink, ctx) {
    for (const child of childNodesOf(el)) walk(child, sink, ctx);
  }

  function walk(node, sink, ctx) {
    if (!node) return;
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      const mode = !ctx.pre && value.includes('\n') && /\S/.test(value) ? preservesBreaks(node.parentElement, ctx) : null;
      if (mode) {
        let t = value.replace(/\r\n?/g, '\n');
        if (mode === 'pre-line') t = t.replace(/[ \t]+/g, ' ');
        sink.raw(t);
      } else {
        sink.text(value, ctx.pre);
      }
      return;
    }
    if (node.nodeType === 11) {
      walkChildren(node, sink, ctx);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    try {
      if (ctx.exclude && ctx.exclude.has(el)) return;
      if (ctx.hook && ctx.hook(el, sink, ctx, API) === true) return;
      if (handleMath(el, sink)) return;
      if (el !== ctx.root) {
        if (ctx.skipSelector && el.matches(ctx.skipSelector)) return;
        if (SKIP_TAGS.has(tag)) return;
      }
      if (ctx.codeWrappers.has(el)) {
        handleCodeWrapper(el, ctx.codeWrappers.get(el), sink);
        return;
      }
      if (handleMermaidContainer(el, sink)) return;

      switch (tag) {
        case 'pre':
          handleCode(el, null, sink);
          return;
        case 'svg':
          handleSvg(el, sink);
          return;
        case 'table':
          handleTable(el, sink, ctx);
          return;
        case 'ul':
        case 'ol':
          handleList(el, sink, ctx);
          return;
        case 'blockquote':
          handleBlockquote(el, sink, ctx);
          return;
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const s = inlineString(el, ctx).replace(/\s*\n\s*/g, ' ').trim();
          if (!s) return;
          sink.breakLine(2);
          sink.raw(`${'#'.repeat(Number(tag[1]))} ${s}`);
          sink.breakLine(2);
          return;
        }
        case 'p':
          sink.breakLine(2);
          walkChildren(el, sink, ctx);
          sink.breakLine(2);
          return;
        case 'br':
          sink.raw('\n');
          return;
        case 'hr':
          sink.breakLine(2);
          sink.raw('---');
          sink.breakLine(2);
          return;
        case 'strong':
        case 'b':
          wrapInline(el, sink, ctx, '**');
          return;
        case 'em':
        case 'i':
          wrapInline(el, sink, ctx, '*');
          return;
        case 'del':
        case 's':
        case 'strike':
          wrapInline(el, sink, ctx, '~~');
          return;
        case 'code': {
          const t = el.textContent || '';
          if (!t) return;
          if (t.includes('\n') && t.trim().split('\n').length > 1) {
            const c = codeToElement(t, codeLanguage(el, null));
            if (c) sink.block(c);
            return;
          }
          const f = '`'.repeat(((t.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0)) + 1);
          const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
          if (!sink.atLineStart() && /[\w)]$/.test(sink.buf)) sink.raw(' ');
          sink.raw(`${f}${pad}${t}${pad}${f}`);
          return;
        }
        case 'a': {
          const href = el.getAttribute('href') || '';
          const text = inlineString(el, ctx).replace(/\s*\n\s*/g, ' ').trim();
          if (!href || /^(javascript:|#)/i.test(href)) {
            if (text) sink.text(` ${text} `);
            return;
          }
          const url = absUrl(href);
          if (!sink.atLineStart() && !sink.buf.endsWith(' ') && /[\w)]$/.test(sink.buf)) sink.raw(' ');
          sink.raw(!text || text === url ? `<${url}>` : `[${text}](${url})`);
          return;
        }
        case 'img': {
          const r = el.getBoundingClientRect();
          const w = r.width || parseFloat(el.getAttribute('width')) || 0;
          const h = r.height || parseFloat(el.getAttribute('height')) || 0;
          if ((w && w <= 32) || (h && h <= 32)) return; // icons, avatars, logos
          let src = el.currentSrc || el.getAttribute('src') || '';
          if (!src.trim()) return;
          const alt = (el.getAttribute('alt') || 'image').replace(/[[\]]/g, '').trim() || 'image';
          if (/^data:/i.test(src)) src = 'data-uri-omitted';
          else src = cleanUrl(src);
          sink.raw(` ![${alt}](${src}) `);
          return;
        }
        case 'iframe': {
          let t = el.getAttribute('title') || el.getAttribute('aria-label') || '';
          if (!t) {
            try {
              const u = new URL(el.getAttribute('src') || '', location.href);
              t = /usercontent\.goog$|googleusercontent\.com$|sandbox/i.test(u.hostname) ? 'sandboxed interactive preview' : `${u.origin}${u.pathname}`;
            } catch {
              t = 'embedded content';
            }
          }
          sink.breakLine(1);
          sink.raw(`[Embedded frame: ${t}]`);
          sink.breakLine(1);
          return;
        }
        case 'video':
        case 'audio': {
          const src = el.currentSrc || el.getAttribute('src') || '';
          sink.raw(` [${tag}${src && !/^(blob|data):/.test(src) ? `: ${src}` : ''}] `);
          return;
        }
        case 'details': {
          sink.breakLine(2);
          walkChildren(el, sink, ctx);
          sink.breakLine(2);
          return;
        }
        case 'summary': {
          const s = inlineString(el, ctx).replace(/\s*\n\s*/g, ' ').trim();
          if (s) {
            sink.breakLine(1);
            sink.raw(`**${s}**`);
            sink.breakLine(1);
          }
          return;
        }
        case 'dt': {
          const s = inlineString(el, ctx).trim();
          if (s) {
            sink.breakLine(1);
            sink.raw(`**${s}**`);
            sink.breakLine(1);
          }
          return;
        }
        case 'dd':
        case 'li':
          sink.breakLine(1);
          walkChildren(el, sink, ctx);
          sink.breakLine(1);
          return;
        default:
          if (BLOCK_TAGS.has(tag)) {
            sink.breakLine(1);
            walkChildren(el, sink, ctx);
            sink.breakLine(1);
          } else {
            walkChildren(el, sink, ctx);
          }
      }
    } catch (err) {
      if (ctx.warn) ctx.warn(`serializer <${tag}>: ${err.message}`);
      try {
        sink.text(el.textContent || '');
      } catch {
        /* give up on this node */
      }
    }
  }

  /**
   * Serialize a DOM subtree into ordered elements:
   *   { kind: 'text'|'code'|'svg'|'mermaid'|'table', payload, language?, title? }
   * opts: { skip?: selector, exclude?: Set<Element>, hook?: (el, sink, ctx, api) => boolean, warn? }
   */
  function serialize(root, opts = {}) {
    if (!root) return [];
    const extra = validSelector(opts.skip || '');
    const ctx = {
      root,
      skipSelector: extra ? `${DEFAULT_SKIP},${extra}` : DEFAULT_SKIP,
      exclude: opts.exclude || null,
      hook: typeof opts.hook === 'function' ? opts.hook : null,
      warn: opts.warn || null,
      codeWrappers: new Map(),
      listDepth: 0,
      pre: false,
    };
    try {
      ctx.codeWrappers = indexCodeWrappers(root);
    } catch {
      /* keep empty */
    }
    const sink = new Sink();
    try {
      walk(root, sink, ctx);
    } catch (err) {
      if (ctx.warn) ctx.warn(`serializer: ${err.message}`);
    }
    const origin = opts.origin || 'inline';
    return finalizeItems(sink.finish()).map((e) => ({ ...e, origin: e.origin || origin }));
  }

  const serializeToMarkdown = (root, opts) => itemsToMarkdown(serialize(root, opts));

  /* ------------------------------------------------------------------ */
  /* Markdown text -> elements (for API-sourced text)                     */
  /* ------------------------------------------------------------------ */

  function splitMarkdown(text, base = {}) {
    const out = [];
    if (!text) return out;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let buf = [];
    const flush = () => {
      const t = cleanText(buf.join('\n'));
      if (t) out.push({ kind: 'text', payload: t, ...base });
      buf = [];
    };
    const tableRow = /^\s*\|.*\|\s*$/;
    const tableSep = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
      if (open) {
        const ch = open[1][0];
        const len = open[1].length;
        const lang = (open[2] || '').toLowerCase();
        const body = [];
        let j = i + 1;
        let closed = false;
        for (; j < lines.length; j++) {
          const close = lines[j].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
          if (close && close[1][0] === ch && close[1].length >= len) {
            closed = true;
            break;
          }
          body.push(lines[j]);
        }
        flush();
        const el = codeToElement(body.join('\n'), lang);
        if (el) out.push({ ...el, ...base });
        i = closed ? j : lines.length;
        continue;
      }
      if (tableRow.test(line) && i + 1 < lines.length && tableSep.test(lines[i + 1])) {
        const tbl = [line, lines[i + 1]];
        let j = i + 2;
        while (j < lines.length && tableRow.test(lines[j])) tbl.push(lines[j++]);
        flush();
        out.push({ kind: 'table', payload: tbl.map((l) => l.trim()).join('\n'), ...base });
        i = j - 1;
        continue;
      }
      buf.push(line);
    }
    flush();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Sweep utilities (virtual scroll, lazy history, toggles)             */
  /* ------------------------------------------------------------------ */

  const isScrollable = (el) => {
    try {
      const s = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
    } catch {
      return false;
    }
  };

  function findScrollContainer(seed) {
    for (let el = seed; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (isScrollable(el)) return el;
    }
    let best = null;
    for (const el of document.querySelectorAll('main *, [role="main"] *, body > * *')) {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 150 && isScrollable(el)) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  const viewportHeight = (container) => {
    const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
    return isDoc ? window.innerHeight : container.clientHeight || window.innerHeight;
  };

  /** Scroll to the very top repeatedly until the message count and height stop changing. */
  async function loadAllHistory(container, ctx, countFn, { settle = 800, maxRounds = 80, pctRange = [4, 14] } = {}) {
    let lastCount = -1;
    let lastHeight = -1;
    let stable = 0;
    let rounds = 0;
    while (!ctx.aborted() && stable < 3 && rounds < maxRounds) {
      rounds++;
      container.scrollTop = 0;
      await sleep(settle);
      let count = 0;
      try {
        count = countFn();
      } catch {
        count = 0;
      }
      const height = container.scrollHeight;
      if (count === lastCount && height === lastHeight && container.scrollTop <= 2) stable++;
      else stable = 0;
      lastCount = count;
      lastHeight = height;
      const pct = pctRange[0] + Math.min(pctRange[1] - pctRange[0], rounds);
      ctx.log(`Loading full history… ${count} messages in DOM`, { key: 'history', pct });
    }
    return lastCount;
  }

  /**
   * Kinematic sweep: top -> bottom by 0.7 viewport steps, calling onStep at every stop.
   * Handles content growing while expanding (re-reads scrollHeight each step).
   */
  async function sweep(container, ctx, onStep, { pause = 350, label = 'Scrolling', pctRange = [15, 90] } = {}) {
    const step = () => Math.max(120, Math.min(window.innerHeight, viewportHeight(container)) * 0.7);
    container.scrollTop = 0;
    await sleep(pause);
    let stuck = 0;
    let lastTop = -1;
    let bottomHits = 0;
    for (let i = 0; i < 5000 && !ctx.aborted(); i++) {
      const max = Math.max(0, container.scrollHeight - viewportHeight(container));
      const pct = max ? Math.min(100, Math.round((container.scrollTop / max) * 100)) : 100;
      ctx.log(`${label} ${pct}%…`, { key: 'scroll', pct: Math.round(pctRange[0] + ((pctRange[1] - pctRange[0]) * pct) / 100) });
      try {
        await onStep(pct);
      } catch (err) {
        ctx.warn(`sweep step failed: ${err.message}`);
      }
      const maxAfter = Math.max(0, container.scrollHeight - viewportHeight(container));
      if (container.scrollTop >= maxAfter - 2) {
        bottomHits++;
        await sleep(pause);
        const grown = container.scrollHeight - viewportHeight(container) > container.scrollTop + 2;
        if (!grown || bottomHits > 5) {
          try {
            await onStep(100);
          } catch (err) {
            ctx.warn(`final sweep step failed: ${err.message}`);
          }
          break;
        }
        continue;
      }
      container.scrollTop = Math.min(container.scrollTop + step(), maxAfter);
      await sleep(pause);
      if (Math.abs(container.scrollTop - lastTop) < 1) {
        if (++stuck >= 4) {
          ctx.warn('Scroll container stopped moving before the bottom; sweep ended early.');
          break;
        }
      } else {
        stuck = 0;
      }
      lastTop = container.scrollTop;
    }
  }

  /** Clickable reasoning toggles found by label text (button / role=button / summary). */
  function findTextToggles(root, re = REASONING_TOGGLE_RE) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    for (const el of root.querySelectorAll('button, [role="button"], summary, [aria-expanded="false"]')) {
      if (el.getAttribute('aria-expanded') === 'true') continue;
      if (re.test(shortText(el))) out.push(el);
    }
    return out;
  }

  /** Click each toggle once per harvest: scrollIntoView(center) + click + hydration delay. */
  async function expandToggles(elements, ctx, { delay = 250 } = {}) {
    let clicked = 0;
    for (const el of elements) {
      if (ctx.aborted()) break;
      if (!el || !el.isConnected || ctx.clicked.has(el)) continue;
      ctx.clicked.add(el);
      try {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        clicked++;
      } catch (err) {
        ctx.warn(`toggle click failed: ${err.message}`);
      }
      await sleep(delay);
    }
    return clicked;
  }

  const turnRichness = (t) =>
    (t.elements || []).reduce((n, e) => n + String(e.payload || '').length, 0) +
    ((t.thinking && t.thinking.steps) || []).reduce((n, s) => n + String(s.content || '').length, 0);

  /** Ordered, de-duplicated turn store that survives virtual-scroll unmounting. */
  class TurnCollector {
    constructor() {
      this.map = new Map();
      this.order = [];
    }
    get size() {
      return this.map.size;
    }
    has(key) {
      return this.map.has(key);
    }
    get(key) {
      return this.map.get(key);
    }
    upsert(key, turn) {
      const prev = this.map.get(key);
      if (!prev) {
        this.map.set(key, turn);
        return;
      }
      const keepPrevThinking = prev.thinking && !turn.thinking;
      const best = turnRichness(turn) >= turnRichness(prev) ? turn : prev;
      this.map.set(key, keepPrevThinking ? { ...best, thinking: prev.thinking } : best);
    }
    /** samples: [{ key, turn }] in DOM order for one viewport stop. */
    ingest(samples) {
      let anchor = -1;
      const pending = [];
      for (const s of samples) {
        if (!s || !s.key || !s.turn) continue;
        if (this.map.has(s.key)) {
          this.upsert(s.key, s.turn);
          let idx = this.order.indexOf(s.key);
          if (anchor === -1 && pending.length) {
            this.order.splice(idx, 0, ...pending);
            idx += pending.length;
            pending.length = 0;
          }
          anchor = idx;
        } else {
          this.map.set(s.key, s.turn);
          if (anchor === -1) pending.push(s.key);
          else {
            this.order.splice(anchor + 1, 0, s.key);
            anchor++;
          }
        }
      }
      if (pending.length) this.order.push(...pending);
    }
    turns() {
      const list = this.order.map((k) => this.map.get(k)).filter(Boolean);
      if (list.length && list.every((t) => typeof t.order === 'number')) list.sort((a, b) => a.order - b.order);
      return list;
    }
  }

  /* ------------------------------------------------------------------ */
  /* MAIN-world bridge                                                   */
  /* ------------------------------------------------------------------ */

  function callMain(triggerEvent, resultEvent, payload = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let timer = null;
      const onResult = (ev) => {
        let data;
        try {
          data = JSON.parse(ev.detail);
        } catch {
          return;
        }
        if (!data || data.requestId !== requestId) return;
        cleanup();
        resolve(data);
      };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener(resultEvent, onResult);
      };
      window.addEventListener(resultEvent, onResult);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MAIN-world bridge timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      window.dispatchEvent(new CustomEvent(triggerEvent, { detail: JSON.stringify({ requestId, ...payload }) }));
    });
  }

  const pingMain = (timeoutMs = 600) =>
    callMain('__LCH_MAIN_PING__', '__LCH_MAIN_PONG__', {}, timeoutMs)
      .then((r) => !!(r && r.ok))
      .catch(() => false);

  /* ------------------------------------------------------------------ */
  /* Transcript builders                                                 */
  /* ------------------------------------------------------------------ */

  const stepToText = (s) => [s.label ? `**${s.label}**` : '', cleanText(s.content || '')].filter(Boolean).join('\n\n');

  function finalizeTranscript(raw, ctx) {
    const includeThinking = ctx.options.includeThinking !== false;
    const turns = [];
    for (const t of raw.turns || []) {
      try {
        const elements = finalizeItems((t.elements || []).filter((e) => e && e.payload != null && String(e.payload).trim()));
        let thinking = null;
        if (includeThinking && t.thinking && Array.isArray(t.thinking.steps) && t.thinking.steps.length) {
          const steps = t.thinking.steps
            .map((s) => ({ type: s.type || 'thinking', label: s.label || undefined, content: cleanText(s.content || '') }))
            .filter((s) => s.content || s.label);
          if (steps.length) thinking = { trace: steps.map(stepToText).join('\n\n'), steps };
        }
        if (!elements.length && !thinking) continue;
        turns.push({ role: t.role === 'user' ? 'user' : 'assistant', elements, thinking });
      } catch (err) {
        ctx.warn(`turn finalization failed: ${err.message}`);
      }
    }
    turns.forEach((t, i) => (t.index = i + 1));
    const platform = detectPlatform();
    return {
      platform: platform ? platform.id : 'unknown',
      platformLabel: platform ? platform.label : location.hostname,
      title: cleanText(raw.title || document.title || 'Untitled conversation').replace(/\s+/g, ' '),
      url: location.href,
      extractedAt: new Date().toISOString(),
      method: raw.method || 'dom',
      model: raw.model || undefined,
      turns,
      warnings: ctx.warnings.slice(),
      partial: !!ctx.aborted(),
    };
  }

  const exportId = () =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `lch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  function buildJSON(t) {
    const pick = (e) => {
      const o = { kind: e.kind, payload: String(e.payload) };
      if (e.language) o.language = e.language;
      if (e.title) o.title = e.title;
      if (e.origin) o.origin = e.origin;
      if (e.artifactType) o.artifactType = e.artifactType;
      if (e.artifactId) o.artifactId = e.artifactId;
      return o;
    };
    return {
      schema: 'UnifiedLLMTranscript',
      schemaVersion: '1.0',
      metadata: {
        exportId: exportId(),
        platform: t.platform,
        conversationTitle: t.title,
        url: t.url,
        extractedAt: t.extractedAt,
        extractionMethod: t.method,
        model: t.model,
        turnCount: t.turns.length,
        partial: t.partial || undefined,
        extractor: `llm-context-harvester@${VERSION}`,
        warnings: t.warnings.length ? t.warnings : undefined,
      },
      turns: t.turns.map((turn) => ({
        index: turn.index,
        role: turn.role,
        thinking: turn.thinking ? { trace: turn.thinking.trace, steps: turn.thinking.steps } : null,
        elements: turn.elements.filter((e) => !e.isReference).map(pick),
      })),
    };
  }

  const yamlStr = (s) => JSON.stringify(String(s == null ? '' : s));

  function widgetHeading(e) {
    const kindLabel = e.kind === 'artifact' ? e.language || e.artifactType || 'artifact' : e.kind;
    return `#### ${e.title || (e.kind === 'svg' ? 'SVG diagram' : e.kind === 'mermaid' ? 'Mermaid diagram' : 'Artifact')} (${kindLabel})`;
  }

  function buildMarkdown(t) {
    const out = [];
    out.push('---');
    out.push(`platform: ${t.platform}`);
    out.push(`title: ${yamlStr(t.title)}`);
    out.push(`url: ${yamlStr(t.url)}`);
    out.push(`extracted_at: ${yamlStr(t.extractedAt)}`);
    out.push(`turn_count: ${t.turns.length}`);
    out.push(`extraction_method: ${t.method}`);
    if (t.model) out.push(`model: ${yamlStr(t.model)}`);
    if (t.partial) out.push('partial: true');
    out.push('---', '');
    out.push(`# Conversation: ${t.title} (Platform: ${t.platformLabel})`, '');

    for (const turn of t.turns) {
      if (turn.role === 'user') {
        out.push(`## Turn ${turn.index} — USER`, '');
        const main = turn.elements.filter((e) => e.origin !== 'attachment');
        const attachments = turn.elements.filter((e) => e.origin === 'attachment');
        const body = itemsToMarkdown(main);
        if (body) out.push(body, '');
        for (const a of attachments) {
          out.push(`#### 📎 Attachment: ${a.title || 'file'}`, '', renderElementMd(a), '');
        }
      } else {
        out.push(`## Turn ${turn.index} — ASSISTANT (${t.platformLabel})`, '');
        if (turn.thinking && turn.thinking.trace) {
          out.push('### 🧠 Thinking / Reasoning Trace', '');
          out.push(turn.thinking.trace.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'), '');
        }
        const inline = turn.elements.filter((e) => !e.origin || e.origin === 'inline');
        const widgets = turn.elements.filter((e) => e.origin === 'artifact' || e.origin === 'tool');
        const body = itemsToMarkdown(inline);
        if (body) out.push('### 💬 Response', '', body, '');
        if (widgets.length) {
          out.push('### 🧩 Extracted Widgets / Artifacts', '');
          for (const w of widgets) out.push(widgetHeading(w), '', renderElementMd(w), '');
        }
      }
      out.push('---', '');
    }
    if (t.warnings.length) {
      out.push('## ⚠️ Extraction warnings', '');
      for (const w of t.warnings) out.push(`- ${w}`);
      out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  const slugify = (s) =>
    String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'conversation';

  const stamp = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  function summarize(t) {
    const count = (pred) => t.turns.reduce((n, turn) => n + turn.elements.filter(pred).length, 0);
    const thinking = t.turns.filter((x) => x.thinking).length;
    const widgets = count((e) => e.origin === 'artifact' || e.origin === 'tool');
    const code = count((e) => e.kind === 'code');
    const diagrams = count((e) => e.kind === 'svg' || e.kind === 'mermaid');
    const tables = count((e) => e.kind === 'table');
    return {
      turns: t.turns.length,
      thinking,
      widgets,
      code,
      diagrams,
      tables,
      method: t.method,
      warnings: t.warnings.length,
      partial: t.partial,
      text: `${t.turns.length} turns · ${thinking} reasoning traces · ${widgets} artifacts · ${code} code blocks · ${diagrams} diagrams · ${tables} tables · via ${t.method}`,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Run state, progress log, popup messaging                            */
  /* ------------------------------------------------------------------ */

  const state = {
    running: false,
    aborted: false,
    log: [],
    pct: 0,
    result: null,
    error: null,
    startedAt: 0,
  };

  const emit = (msg) => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* popup closed or extension reloaded */
    }
  };

  function log(msg, { pct, level = 'info', key } = {}) {
    if (typeof pct === 'number') state.pct = Math.max(0, Math.min(100, pct));
    const entry = { t: Date.now(), level, msg: String(msg), pct: state.pct, key: key || null };
    const last = state.log[state.log.length - 1];
    if (key && last && last.key === key) state.log[state.log.length - 1] = entry;
    else state.log.push(entry);
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    emit({ type: 'LCH_PROGRESS', entry });
  }

  function currentResult() {
    if (!state.result) return null;
    if (state.result.url !== location.href) return null;
    return state.result;
  }

  function status() {
    const r = currentResult();
    return {
      ok: true,
      running: state.running,
      pct: state.pct,
      log: state.log,
      error: state.error,
      hasResult: !!r,
      summary: r ? r.summary : null,
      filenameBase: r ? r.filenameBase : null,
    };
  }

  function guessTitle() {
    const platform = detectPlatform();
    const adapter = platform && LCH.adapters[platform.id];
    try {
      if (adapter && typeof adapter.getTitle === 'function') {
        const t = adapter.getTitle();
        if (t) return t;
      }
    } catch {
      /* fall back */
    }
    return document.title;
  }

  async function runHarvest(options = {}) {
    if (state.running) return;
    state.running = true;
    state.aborted = false;
    state.error = null;
    state.log = [];
    state.pct = 0;
    state.startedAt = Date.now();

    const warnings = [];
    const ctx = {
      options,
      warnings,
      clicked: new WeakSet(),
      aborted: () => state.aborted,
      log,
      warn: (msg) => {
        const m = String(msg);
        if (warnings.length < 200 && !warnings.includes(m)) warnings.push(m);
        log(m, { level: 'warn' });
      },
      core: API,
    };

    try {
      const platform = detectPlatform();
      if (!platform) throw new Error(`Unsupported site: ${location.hostname}`);
      const adapter = LCH.adapters[platform.id];
      if (!adapter || typeof adapter.harvest !== 'function') throw new Error(`No adapter registered for ${platform.label}`);

      log(`Starting harvest on ${platform.label}…`, { pct: 1 });
      const raw = await adapter.harvest(ctx);
      if (state.aborted) ctx.warn('Harvest stopped by user — partial export.');

      log('Serializing turns…', { pct: 95 });
      const transcript = finalizeTranscript(raw || { turns: [] }, ctx);
      if (!transcript.turns.length) throw new Error('No messages found on this page. Open a conversation and try again.');

      const markdown = buildMarkdown(transcript);
      const json = JSON.stringify(buildJSON(transcript), null, 2);
      const summary = summarize(transcript);
      state.result = {
        url: location.href,
        markdown,
        json,
        summary,
        filenameBase: `${transcript.platform}-${slugify(transcript.title)}-${stamp()}`,
      };
      log(`Ready! ${summary.text}`, { pct: 100, level: 'success' });
      emit({ type: 'LCH_DONE', ok: true, summary });
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
      log(`Harvest failed: ${state.error}`, { level: 'error' });
      emit({ type: 'LCH_DONE', ok: false, error: state.error });
    } finally {
      state.running = false;
    }
  }

  const onMessage = (msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('LCH_')) return undefined;
    try {
      switch (msg.type) {
        case 'LCH_PING': {
          const platform = detectPlatform();
          sendResponse({
            ok: true,
            version: VERSION,
            platform: platform ? platform.id : null,
            platformLabel: platform ? platform.label : null,
            title: guessTitle(),
            status: status(),
          });
          break;
        }
        case 'LCH_STATUS':
          sendResponse(status());
          break;
        case 'LCH_START':
          if (state.running) sendResponse({ started: false, reason: 'A harvest is already running on this tab.' });
          else {
            runHarvest(msg.options || {});
            sendResponse({ started: true });
          }
          break;
        case 'LCH_ABORT':
          state.aborted = true;
          sendResponse({ ok: true });
          break;
        case 'LCH_GET_RESULT': {
          const r = currentResult();
          sendResponse(r ? { ok: true, ...r } : { ok: false, error: 'No harvest result for this page yet.' });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return undefined;
  };

  chrome.runtime.onMessage.addListener(onMessage);

  const API = {
    VERSION,
    sleep,
    hashString,
    cleanText,
    shortText,
    isVisible,
    langFromFilename,
    normalizeLang,
    cleanUrl,
    detectPlatform,
    MERMAID_RE,
    BOX_RE,
    REASONING_TOGGLE_RE,
    serialize,
    serializeToMarkdown,
    renderElementMd,
    itemsToMarkdown,
    splitMarkdown,
    codeToElement,
    fenced,
    findScrollContainer,
    loadAllHistory,
    sweep,
    findTextToggles,
    expandToggles,
    TurnCollector,
    callMain,
    pingMain,
    // exposed for tests / debugging
    _buildMarkdown: buildMarkdown,
    _buildJSON: buildJSON,
    _finalizeTranscript: finalizeTranscript,
  };

  LCH.core = API;
  LCH.version = VERSION;
  LCH.dispose = () => {
    state.aborted = true;
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* runtime already invalidated */
    }
  };
})();
