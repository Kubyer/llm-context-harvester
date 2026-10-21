/*
 * LLM Context Harvester — Meta AI adapter (www.meta.ai).
 *
 * Strategy: lazy-history loading (older turns load when scrolled to the top) + timed sweep.
 * At every stop, each assistant message not yet processed gets its reasoning opened:
 * "Afficher la réflexion" opens a *side panel* (tabs "Étapes" / "Sources"), not an inline
 * accordion. The panel is scraped, then closed, with ~250 ms pacing between clicks so the
 * React tree never desynchronizes. Inline accordions are handled as a fallback.
 *
 * DOM calibrated 2026-10:
 *   [role="feed"] inside a scrollable div[data-scroll-container]
 *   [data-message-item][data-message-role="user"|"assistant"][data-turn-id][data-message-id]
 *   [data-testid="assistant-message"] (.markdown-content / .ur-markdown)
 *   [data-testid="thinking-status"] inside the div[role="button"] toggle
 *   panel close: button[aria-label="Fermer le panneau de réflexion"]
 *   code: .ur-code-block > .ur-code-block__header (.ur-code-block__metadata) + pre > code
 *   citations: a[data-testid="citation-pill"][data-citation-urls]
 */
(() => {
  'use strict';

  const LCH = (globalThis.__LCH__ = globalThis.__LCH__ || { adapters: {} });

  const SEL = {
    feed: '[role="feed"]',
    item: '[data-message-item][data-message-role]',
    assistantBody: '[data-testid="assistant-message"]',
    thinkingStatus: '[data-testid="thinking-status"]',
  };

  const SKIP = [
    '[data-testid="thinking-status"]',
    '[data-testid="thinking-status-chevron"]',
    '[data-testid="subagent-cot-list"]',
    '[data-testid="sources-pill"]',
    '[data-testid="message-actions"]',
    '[data-testid*="feedback"]',
    '[data-scrollbar-thumb]',
  ].join(',');

  const PANEL_CLOSE_RE = /((fermer|close|masquer|hide).*(réflexion|raisonnement|thinking|reasoning|panneau|panel))|((réflexion|thinking|reasoning).*(fermer|close))/i;
  const STEPS_TAB_RE = /^(étapes|steps)$/i;
  const SOURCES_TAB_RE = /^(sources)$/i;

  const getTitle = () => {
    try {
      const link = document.querySelector(`a[href="${CSS.escape(location.pathname)}"]`);
      const t = link && link.textContent.replace(/\s+/g, ' ').trim();
      if (t) return t;
    } catch {
      /* fall through */
    }
    const doc = document.title.replace(/\s*[-–|]\s*Meta AI.*$/i, '').trim();
    return doc && !/^meta ai$/i.test(doc) ? doc : 'Meta AI conversation';
  };

  const keyOf = (item, core) => {
    const role = item.getAttribute('data-message-role') === 'user' ? 'user' : 'assistant';
    const id = item.getAttribute('data-turn-id') || item.getAttribute('data-message-id') || `h${core.hashString((item.textContent || '').slice(0, 400))}`;
    return `${id}:${role}`;
  };

  function findPanelClose(core) {
    return [...document.querySelectorAll('button[aria-label]')].find((b) => PANEL_CLOSE_RE.test(b.getAttribute('aria-label') || '') && core.isVisible(b)) || null;
  }

  function panelRootFrom(btn) {
    const feed = document.querySelector(SEL.feed);
    let best = null;
    for (let el = btn.parentElement; el && el !== document.body; el = el.parentElement) {
      if (feed && el.contains(feed)) break;
      best = el;
      if (el.getBoundingClientRect().height >= window.innerHeight * 0.6) break;
    }
    return best;
  }

  const findTab = (panel, re) => [...panel.querySelectorAll('button, [role="tab"]')].find((b) => re.test((b.textContent || '').trim())) || null;

  async function waitForPanel(core, timeoutMs = 2500) {
    const start = Date.now();
    let lastLen = -1;
    while (Date.now() - start < timeoutMs) {
      const close = findPanelClose(core);
      if (close) {
        const root = panelRootFrom(close);
        const len = root ? (root.textContent || '').length : 0;
        if (root && len > 0 && len === lastLen) return root;
        lastLen = len;
      }
      await core.sleep(150);
    }
    const close = findPanelClose(core);
    return close ? panelRootFrom(close) : null;
  }

  async function closePanel(core) {
    const close = findPanelClose(core);
    if (close) {
      close.click();
      await core.sleep(250);
    }
  }

  async function expandInside(root, ctx) {
    const more = [...root.querySelectorAll('[aria-expanded="false"]')].filter((b) => !ctx.clicked.has(b));
    for (const b of more) {
      ctx.clicked.add(b);
      try {
        b.click();
      } catch {
        /* ignore */
      }
      await ctx.core.sleep(250);
    }
  }

  function collectLinks(root, core) {
    const seen = new Map();
    for (const a of root.querySelectorAll('a[href^="http"]')) {
      const href = core.cleanUrl(a.href);
      if (!seen.has(href)) seen.set(href, (a.textContent || '').replace(/\s+/g, ' ').trim() || href);
    }
    return [...seen].map(([href, text]) => `- [${text.replace(/[[\]]/g, '')}](${href})`).join('\n');
  }

  /** Opens the reasoning of one assistant item and returns { steps } (or null). */
  async function openThinking(item, ctx) {
    const core = ctx.core;
    const status = item.querySelector(SEL.thinkingStatus);
    let toggle = status ? status.closest('[role="button"], button') : null;
    if (!toggle) toggle = core.findTextToggles(item)[0] || null;
    if (!toggle || ctx.clicked.has(toggle)) return null;
    const rawLabel = core.shortText(status || toggle, 100);
    // "Afficher la réflexion" / "Show thinking" is a button caption, not a useful step title.
    const label = !rawLabel || /^(afficher|voir|show|view)\b/i.test(rawLabel) ? 'Reasoning steps' : rawLabel;

    await closePanel(core);
    ctx.clicked.add(toggle);
    try {
      toggle.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    } catch {
      /* ignore */
    }
    toggle.click();
    await core.sleep(250);

    const panel = await waitForPanel(core);
    if (panel) {
      const steps = [];
      try {
        const stepsTab = findTab(panel, STEPS_TAB_RE);
        if (stepsTab) {
          stepsTab.click();
          await core.sleep(300);
        }
        await expandInside(panel, ctx);
        const md = core.serializeToMarkdown(panel, { skip: SKIP, warn: ctx.warn });
        steps.push({ type: 'thinking', label: `💭 ${label}`, content: md });
        const sourcesTab = findTab(panel, SOURCES_TAB_RE);
        if (sourcesTab) {
          sourcesTab.click();
          await core.sleep(400);
          await expandInside(panel, ctx);
          const links = collectLinks(panel, core);
          if (links) steps.push({ type: 'sources', label: '📚 Sources', content: links });
          if (stepsTab) stepsTab.click();
        }
      } catch (err) {
        ctx.warn(`Meta AI reasoning panel scrape failed: ${err.message}`);
      }
      await closePanel(core);
      return steps.length ? { steps } : null;
    }

    // Inline accordion fallback.
    await core.sleep(250);
    const regionId = toggle.getAttribute('aria-controls');
    const region = regionId ? document.getElementById(regionId) : null;
    if (region) {
      const md = core.serializeToMarkdown(region, { skip: SKIP, warn: ctx.warn });
      if (md) return { steps: [{ type: 'thinking', label: `💭 ${label}`, content: md }], region };
    }
    return null;
  }

  function sample(item, ctx, thinkingByKey) {
    const core = ctx.core;
    const key = keyOf(item, core);
    const role = key.endsWith(':user') ? 'user' : 'assistant';
    const cached = thinkingByKey.get(key);
    const exclude = new Set();
    if (cached && cached.region) exclude.add(cached.region);
    const body = role === 'assistant' ? item.querySelector(SEL.assistantBody) || item : item;
    const elements = core.serialize(body, { skip: SKIP, exclude, warn: ctx.warn });
    return { key, turn: { role, elements, thinking: cached ? { steps: cached.steps } : null } };
  }

  LCH.adapters['meta-ai'] = {
    id: 'meta-ai',
    getTitle,
    async harvest(ctx) {
      const core = ctx.core;
      const feed = document.querySelector(SEL.feed);
      const firstItem = document.querySelector(SEL.item);
      if (!feed && !firstItem) throw new Error('No Meta AI conversation found. Open a conversation (meta.ai/prompt/…) first.');
      const scroller = core.findScrollContainer(feed || firstItem);
      ctx.log('Scroll container located. Loading older turns…', { pct: 3 });

      await closePanel(core);
      await core.loadAllHistory(scroller, ctx, () => document.querySelectorAll(SEL.item).length);

      const collector = new core.TurnCollector();
      const thinkingByKey = new Map();
      const wantThinking = ctx.options.includeThinking !== false;
      let opened = 0;

      await core.sweep(scroller, ctx, async () => {
        if (wantThinking) {
          const pending = [...document.querySelectorAll(SEL.item)].filter(
            (it) => it.getAttribute('data-message-role') !== 'user' && !thinkingByKey.has(keyOf(it, core)),
          );
          const withToggle = pending.filter((it) => it.querySelector(SEL.thinkingStatus) || core.findTextToggles(it).length);
          if (withToggle.length) ctx.log(`Expanding thoughts (${withToggle.length} found)…`);
          for (const it of pending) {
            if (ctx.aborted()) break;
            const key = keyOf(it, core);
            try {
              const th = await openThinking(it, ctx);
              thinkingByKey.set(key, th);
              if (th) opened++;
            } catch (err) {
              thinkingByKey.set(key, null);
              ctx.warn(`Meta AI reasoning skipped: ${err.message}`);
            }
          }
        }
        const samples = [];
        for (const it of document.querySelectorAll(SEL.item)) {
          try {
            samples.push(sample(it, ctx, thinkingByKey));
          } catch (err) {
            ctx.warn(`Meta AI message skipped: ${err.message}`);
          }
        }
        collector.ingest(samples);
      });

      await closePanel(core);
      ctx.log(`Collected ${collector.size} messages (${opened} reasoning traces opened).`, { pct: 92 });
      return { title: getTitle(), method: 'dom', turns: collector.turns() };
    },
  };
})();
