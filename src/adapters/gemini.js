/*
 * LLM Context Harvester — Google Gemini adapter (gemini.google.com).
 *
 * Strategy: lazy-history loading (scroll to top until stable) + kinematic sweep of the
 * `infinite-scroller.chat-history` container. At every stop: expand thought panels
 * ("Afficher la réflexion" / "Show thinking"), then sample every `.conversation-container`
 * into an ordered, de-duplicated collector keyed by the container id.
 *
 * DOM calibrated 2026-10:
 *   infinite-scroller.chat-history (overflow-y: scroll)
 *   .conversation-container#<id> > user-query + model-response
 *   user-query .query-text > p.query-text-line   (+ h5.cdk-visually-hidden label to skip)
 *   model-response message-content .markdown.markdown-main-panel
 *   code-block > .code-block-decoration span (language) + pre > code.code-container
 *   span.math-inline[data-math] / .math-block[data-math] (KaTeX inside)
 *   table-block > .table-content > table
 *   model-thoughts + button[data-test-id="thoughts-header-button"] (reasoning models)
 *   Canvas: immersive-entry-chip (inline preview, button "Plein écran") opens
 *     immersive-panel > code-immersive-panel > xap-code-editor (Monaco, virtualized lines);
 *     full source read from window.monaco through the MAIN world. Closed with "Réduire".
 */
(() => {
  'use strict';

  const LCH = (globalThis.__LCH__ = globalThis.__LCH__ || { adapters: {} });

  const SEL = {
    scroller: 'infinite-scroller.chat-history, #chat-history infinite-scroller, [data-test-id="chat-history-container"] infinite-scroller',
    container: '.conversation-container',
    user: 'user-query',
    response: 'model-response',
    body: 'message-content .markdown-main-panel, message-content .markdown, message-content',
    thoughts: 'model-thoughts',
    thoughtsButton: '[data-test-id="thoughts-header-button"]',
    thoughtsContent: '[data-test-id="thoughts-content"], .thoughts-content, .thoughts-body, .thoughts-container',
  };

  const SKIP = [
    'sources-list',
    'message-actions',
    'thinking-overlay',
    'model-thoughts',
    'overview-carousel',
    'freemium-rag-disclaimer',
    'election-info-disclaimer',
    'finance-info-disclaimer',
    'sensitive-memories-banner',
    '.screen-reader-model-response-label',
    '.screen-reader-user-query-label',
    '.response-footer',
    '[data-test-id="thoughts-header-button"]',
  ].join(',');

  const USER_SKIP = '.cdk-visually-hidden, .luminous-actions-container, [data-test-id="prompt-copy-button"], [data-test-id="prompt-edit-button"]';

  const getTitle = () => {
    const fromDoc = document.title.replace(/\s*[-–|]\s*(Google\s+)?Gemini\s*$/i, '').trim();
    if (fromDoc && !/^(google\s+)?gemini$/i.test(fromDoc)) return fromDoc;
    const header = document.querySelector('[data-test-id="header-title"]');
    return (header && header.textContent.trim()) || 'Gemini conversation';
  };

  const CANVAS = {
    chip: 'immersive-entry-chip',
    panel: 'immersive-panel, code-immersive-panel',
    openButton: /plein écran|full ?screen|agrandir|expand/i,
    closeButton: /réduire|minimi[sz]e|collapse|fermer|close/i,
  };

  const chipTitle = (chip) => {
    const t = chip.querySelector('.title') || chip;
    return (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Canvas';
  };

  /**
   * Gemini-specific nodes: Canvas chips and mini-apps become reference lines, inline source
   * chips keep their source name (their URLs only exist in a popover, never in the DOM).
   */
  const hook = (el, sink) => {
    const tag = el.localName || '';
    if (tag.includes('immersive') && (tag.includes('chip') || tag.includes('entry'))) {
      sink.breakLine(2);
      sink.raw(`> 🧩 Canvas **${chipTitle(el)}** — source in *Extracted Widgets / Artifacts* below.`);
      sink.breakLine(2);
      return true;
    }
    if (tag === 'mini-app' || tag === 'web-preview') {
      sink.breakLine(2);
      sink.raw('> 🧩 Interactive visual (Gemini mini-app) — rendered in a sandbox; its source is not exportable.');
      sink.breakLine(2);
      return true;
    }
    if (tag === 'source-footnote' || tag === 'sources-carousel-inline' || tag === 'source-inline-chip') {
      const titles = [...new Set([...el.querySelectorAll('.source-title')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (titles.length) sink.raw(` [source: ${titles.join('; ')}]`);
      return true;
    }
    return false;
  };

  async function waitFor(fn, core, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await core.sleep(150);
    }
    return fn();
  }

  async function closeCanvasPanel(core) {
    const btn = [...document.querySelectorAll(`${CANVAS.panel.split(',').map((s) => `${s.trim()} button`).join(', ')}`)].find((b) =>
      CANVAS.closeButton.test(b.getAttribute('aria-label') || ''),
    );
    if (btn) {
      btn.click();
      await core.sleep(400);
    }
  }

  /** Reads one opened canvas: Monaco source via the MAIN world, else the panel's text. */
  async function readOpenCanvas(ctx, mainAvailable) {
    const core = ctx.core;
    if (mainAvailable) {
      try {
        const r = await core.callMain('__LCH_GEMINI_CANVAS__', '__LCH_GEMINI_CANVAS_RESULT__', {}, 5000);
        const editors = (r && r.ok && r.editors) || [];
        const pick = editors.find((e) => e.inPanel && e.value && e.value.trim()) || editors.find((e) => e.value && e.value.trim());
        if (pick) {
          const el = core.codeToElement(pick.value, pick.language) || { kind: 'code', payload: pick.value };
          return { ...el, kind: el.kind === 'code' ? 'artifact' : el.kind, language: el.language || core.normalizeLang(pick.language) || undefined };
        }
        if (r && !r.ok && r.error) ctx.warn(`Canvas editor: ${r.error}`);
      } catch (err) {
        ctx.warn(`Canvas bridge: ${err.message}`);
      }
    }
    const panel = document.querySelector(CANVAS.panel);
    if (!panel) return null;
    const md = core.serializeToMarkdown(panel, { skip: 'toolbar, [class*="toolbar"], [class*="header"], .monaco-editor', warn: ctx.warn });
    return md.trim() ? { kind: 'artifact', payload: md, language: 'markdown' } : null;
  }

  async function captureCanvases(ctx, collector) {
    const core = ctx.core;
    const chips = [...document.querySelectorAll(CANVAS.chip)];
    if (!chips.length) return 0;
    ctx.log(`Opening ${chips.length} Canvas document(s)…`, { pct: 91 });
    const mainAvailable = await core.pingMain(800);
    let captured = 0;
    for (const chip of chips) {
      if (ctx.aborted()) break;
      const container = chip.closest(SEL.container);
      const turn = container && container.id ? collector.get(`${container.id}:assistant`) : null;
      if (!turn) continue;
      const title = chipTitle(chip);
      try {
        await closeCanvasPanel(core);
        const opener =
          [...chip.querySelectorAll('button')].find((b) => CANVAS.openButton.test(b.getAttribute('aria-label') || '')) ||
          chip.querySelector('.inline-preview-container, .title-container') ||
          chip;
        opener.scrollIntoView({ behavior: 'instant', block: 'center' });
        opener.click();
        await waitFor(() => document.querySelector(CANVAS.panel), core, 3000);
        await core.sleep(600);
        const el = await readOpenCanvas(ctx, mainAvailable);
        if (el && el.payload) {
          const dup = turn.elements.some((e) => e.origin === 'artifact' && e.payload === el.payload);
          if (!dup) {
            turn.elements.push({ ...el, title, origin: 'artifact', artifactType: 'gemini-canvas' });
            captured++;
          }
        } else {
          ctx.warn(`Canvas "${title}": content could not be read.`);
        }
      } catch (err) {
        ctx.warn(`Canvas "${title}" skipped: ${err.message}`);
      }
      await closeCanvasPanel(core);
      await core.sleep(250);
    }
    return captured;
  }

  function userElements(uq, ctx) {
    const core = ctx.core;
    const lines = [...uq.querySelectorAll('.query-text-line')];
    const elements = [];
    const files = uq.querySelector('.file-preview-container');
    if (files && files.textContent.trim()) {
      elements.push(...core.serialize(files, { skip: USER_SKIP, warn: ctx.warn }));
    }
    for (const img of uq.querySelectorAll('[data-test-id="uploaded-img"] img, img[data-test-id="uploaded-img"]')) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      elements.push({ kind: 'text', payload: `![uploaded image](${/^https?:/i.test(src) ? src : 'local-upload'})`, origin: 'inline' });
    }
    if (lines.length) {
      const text = lines.map((p) => p.textContent.replace(/\u00a0/g, ' ')).join('\n');
      elements.push(...core.splitMarkdown(text, { origin: 'inline' }));
    } else {
      const root = uq.querySelector('.query-text') || uq.querySelector('user-query-content') || uq;
      elements.push(...core.serialize(root, { skip: USER_SKIP, warn: ctx.warn }));
    }
    return elements;
  }

  function extractThoughts(mr, ctx) {
    const core = ctx.core;
    const mt = mr.querySelector(SEL.thoughts);
    if (mt) {
      const content = mt.querySelector(SEL.thoughtsContent) || mt;
      const md = core.serializeToMarkdown(content, { skip: `${SEL.thoughtsButton}, .thoughts-header`, warn: ctx.warn });
      if (md.trim()) return { steps: [{ type: 'thinking', label: '💭 Thinking', content: md }] };
    }
    // The model reasoned (.has-thoughts) but Gemini no longer displays the trace once the answer is done.
    if (mr.querySelector('.has-thoughts')) {
      return { steps: [{ type: 'thinking', label: '💭 Reasoning used — trace not exposed by Gemini once the answer is complete', content: '' }] };
    }
    return null;
  }

  function assistantElements(mr, ctx) {
    const body = mr.querySelector(SEL.body) || mr;
    return ctx.core.serialize(body, { skip: SKIP, hook, warn: ctx.warn });
  }

  function thoughtToggles(ctx) {
    const core = ctx.core;
    const out = new Set();
    for (const b of document.querySelectorAll(SEL.thoughtsButton)) {
      if (ctx.clicked.has(b)) continue;
      const mt = b.closest(SEL.thoughts);
      const content = mt && mt.querySelector(SEL.thoughtsContent);
      const open = b.getAttribute('aria-expanded') === 'true' || (content && content.textContent.trim().length > 0 && core.isVisible(content));
      if (!open) out.add(b);
    }
    for (const mr of document.querySelectorAll(SEL.response)) {
      for (const t of core.findTextToggles(mr)) if (!ctx.clicked.has(t)) out.add(t);
    }
    return [...out];
  }

  function sampleAll(ctx) {
    const core = ctx.core;
    const samples = [];
    const containers = [...document.querySelectorAll(SEL.container)];
    if (containers.length) {
      for (const c of containers) {
        try {
          const id = c.id || `h${core.hashString((c.textContent || '').slice(0, 500))}`;
          const uq = c.querySelector(SEL.user);
          if (uq) samples.push({ key: `${id}:user`, turn: { role: 'user', elements: userElements(uq, ctx), thinking: null } });
          const mr = c.querySelector(SEL.response);
          if (mr) {
            samples.push({
              key: `${id}:assistant`,
              turn: { role: 'assistant', elements: assistantElements(mr, ctx), thinking: extractThoughts(mr, ctx) },
            });
          }
        } catch (err) {
          ctx.warn(`Gemini turn skipped: ${err.message}`);
        }
      }
      return samples;
    }
    // Fallback: bare user-query / model-response nodes in document order.
    for (const node of document.querySelectorAll(`${SEL.user}, ${SEL.response}`)) {
      try {
        const isUser = node.localName === 'user-query';
        const key = `${isUser ? 'u' : 'a'}:${core.hashString((node.textContent || '').slice(0, 400))}`;
        samples.push({
          key,
          turn: isUser
            ? { role: 'user', elements: userElements(node, ctx), thinking: null }
            : { role: 'assistant', elements: assistantElements(node, ctx), thinking: extractThoughts(node, ctx) },
        });
      } catch (err) {
        ctx.warn(`Gemini message skipped: ${err.message}`);
      }
    }
    return samples;
  }

  LCH.adapters.gemini = {
    id: 'gemini',
    getTitle,
    async harvest(ctx) {
      const core = ctx.core;
      const first = document.querySelector(`${SEL.container}, ${SEL.user}, ${SEL.response}`);
      if (!first) throw new Error('No Gemini conversation found. Open a chat (gemini.google.com/app/…) first.');
      const scroller = document.querySelector(SEL.scroller) || core.findScrollContainer(first);
      ctx.log('Scroll container located. Loading older turns…', { pct: 3 });

      await core.loadAllHistory(scroller, ctx, () => document.querySelectorAll(SEL.container).length || document.querySelectorAll(`${SEL.user}, ${SEL.response}`).length);

      const collector = new core.TurnCollector();
      let expanded = 0;
      await core.sweep(scroller, ctx, async () => {
        if (ctx.options.includeThinking !== false) {
          const toggles = thoughtToggles(ctx);
          if (toggles.length) {
            ctx.log(`Expanding thoughts (${toggles.length} found)…`);
            expanded += await core.expandToggles(toggles, ctx, { delay: 250 });
          }
        }
        collector.ingest(sampleAll(ctx));
      });

      ctx.log(`Collected ${collector.size} messages (${expanded} thought panels expanded).`, { pct: 90 });

      const canvases = await captureCanvases(ctx, collector);
      if (canvases) ctx.log(`Captured ${canvases} Canvas document(s).`, { pct: 93 });

      return { title: getTitle(), method: 'dom', turns: collector.turns() };
    },
  };
})();
