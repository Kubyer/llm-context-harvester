/*
 * LLM Context Harvester — Claude adapter (claude.ai).
 *
 * Strategy:
 *   1. Active API fetch from the MAIN world (page cookies) via '__TRIGGER_CLAUDE_FETCH__'.
 *   2. Direct same-origin fetch from the ISOLATED world (content scripts send page cookies too).
 *   3. DOM sweep fallback over the virtualized transcript, expanding thinking/tool rows.
 *
 * API shape (calibrated 2026-10): chat_messages[] with sender, index, parent_message_uuid,
 * attachments[] (file_name, extracted_content), files[], content[] blocks:
 *   text {text, citations} · thinking {thinking, summaries[{summary}], cut_off, truncated}
 *   tool_use {id, name, input, message} · tool_result {tool_use_id, name, content[], is_error}
 * Tools seen: web_search, web_fetch/WebFetch, artifacts {command,id,type,title,content,language,old_str,new_str},
 *   create_file {path,file_text}, str_replace {path,old_str,new_str}, visualize:show_widget {title,widget_code},
 *   bash_tool, view, repl, memory_*, conversation_search, present_files…
 */
(() => {
  'use strict';

  const LCH = (globalThis.__LCH__ = globalThis.__LCH__ || { adapters: {} });

  const CHAT_RE = /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
  const MAX_RESULT_CHARS = 1500;

  const ARTIFACT_TYPES = {
    'application/vnd.ant.mermaid': { kind: 'mermaid', language: 'mermaid' },
    'image/svg+xml': { kind: 'svg', language: 'svg' },
    'application/vnd.ant.react': { kind: 'artifact', language: 'jsx' },
    'text/html': { kind: 'artifact', language: 'html' },
    'text/markdown': { kind: 'artifact', language: 'markdown' },
    'application/vnd.ant.code': { kind: 'artifact', language: null },
  };

  const SILENT_RESULT_TOOLS = /^(artifacts|create_file|str_replace|present_files|visualize:read_me|visualize:show_widget|show_widget)$/;
  const APPROVAL_PAUSE_RE = /doesn't want to take this action right now|wait for the user to tell you how to proceed/i;

  /**
   * Human messages the user did not type: the "(approval answered)" marker and tool results
   * delivered after an approval. Real prompts carry an input_mode ("text", "speech_input").
   */
  const isProtocolMessage = (m) => {
    if (!m || m.sender !== 'human' || m.input_mode) return false;
    if ((m.attachments && m.attachments.length) || (m.files && m.files.length)) return false;
    const blocks = Array.isArray(m.content) ? m.content : [];
    return (
      blocks.length > 0 &&
      blocks.every((b) => b.type === 'tool_result' || (b.type === 'text' && /^\s*\([^()]{1,60}\)\s*$/.test(b.text || '')))
    );
  };

  const truncate = (s, n = MAX_RESULT_CHARS) => {
    const t = String(s || '');
    return t.length > n ? `${t.slice(0, n)}\n… [truncated ${t.length - n} chars]` : t;
  };

  const getTitle = () => document.title.replace(/\s*[-–|]\s*Claude\s*$/i, '').trim();

  /* ---------------------------- API retrieval ---------------------------- */

  async function fetchDirect(convId) {
    const getJSON = async (url) => {
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url.split('?')[0]}`);
      return res.json();
    };
    const qs = 'tree=True&rendering_mode=messages&render_all_tools=true';
    const errors = [];
    const tried = new Set();
    const attempt = async (orgId) => {
      if (!orgId || tried.has(orgId)) return null;
      tried.add(orgId);
      try {
        const data = await getJSON(`/api/organizations/${orgId}/chat_conversations/${convId}?${qs}`);
        if (data && Array.isArray(data.chat_messages)) return data;
      } catch (err) {
        errors.push(err.message);
      }
      return null;
    };
    const cookie = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1];
    const viaCookie = await attempt(cookie && decodeURIComponent(cookie));
    if (viaCookie) return viaCookie;
    const orgs = await getJSON('/api/organizations');
    for (const org of Array.isArray(orgs) ? orgs : []) {
      const data = await attempt(org && org.uuid);
      if (data) return data;
    }
    throw new Error(errors.join(' | ') || 'conversation not found in any organization');
  }

  async function fetchConversation(ctx, convId) {
    const core = ctx.core;
    ctx.log('Requesting full conversation tree from the Claude API (page context)…', { pct: 8 });
    try {
      if (await core.pingMain(800)) {
        const r = await core.callMain('__TRIGGER_CLAUDE_FETCH__', '__CLAUDE_FETCH_RESULT__', {}, 30000);
        if (r && r.ok && r.data) {
          if (r.warning) ctx.warn(`Active API call failed (${r.warning}); used the response cached by the fetch hook.`);
          return { data: r.data, source: r.source };
        }
        ctx.warn(`Claude API via page context failed: ${(r && r.error) || 'unknown error'}`);
      } else {
        ctx.log('MAIN-world interceptor not reachable, trying a direct fetch…', { level: 'warn' });
      }
    } catch (err) {
      ctx.warn(`MAIN-world bridge error: ${err.message}`);
    }
    try {
      ctx.log('Requesting conversation directly from the content script…', { pct: 12 });
      return { data: await fetchDirect(convId), source: 'direct-api' };
    } catch (err) {
      ctx.warn(`Direct Claude API fetch failed: ${err.message}`);
    }
    return null;
  }

  /* ----------------------------- API parsing ----------------------------- */

  function activeBranch(data) {
    const msgs = Array.isArray(data.chat_messages) ? data.chat_messages : [];
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    const leaf = data.current_leaf_message_uuid;
    if (leaf && byId.has(leaf)) {
      const chain = [];
      const seen = new Set();
      for (let m = byId.get(leaf); m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
        seen.add(m.uuid);
        chain.push(m);
        if (!m.parent_message_uuid || m.parent_message_uuid === ROOT_PARENT) break;
      }
      return chain.reverse();
    }
    return [...msgs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  function describeInput(core, name, input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string' && /bash|shell|terminal/i.test(name)) return core.fenced(input.command, 'bash');
    if (typeof input.code === 'string') return core.fenced(input.code, core.normalizeLang(input.language || ''));
    const json = JSON.stringify(input, null, 2);
    return core.fenced(truncate(json), 'json');
  }

  /** Splits legacy inline tags (<antArtifact>, <antThinking>) out of a text block. */
  function splitLegacyTags(text) {
    const parts = [];
    const re = /<(antArtifact|antThinking)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
      const attrs = {};
      m[2].replace(/(\w+)\s*=\s*"([^"]*)"/g, (_, k, v) => {
        attrs[k] = v;
        return '';
      });
      parts.push(m[1] === 'antThinking' ? { type: 'thinking', text: m[3] } : { type: 'artifact', attrs, content: m[3].replace(/^\n+|\n+$/g, '') });
      last = re.lastIndex;
    }
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return parts;
  }

  function parseApi(data, ctx) {
    const core = ctx.core;
    const artifacts = new Map(); // id -> { id, title, type, language, content, version }
    const files = new Map(); // path -> { path, content, version }
    const turns = [];

    const applyArtifact = (input) => {
      const id = input.id || input.identifier || `artifact-${artifacts.size + 1}`;
      const prev = artifacts.get(id);
      const cmd = input.command || 'create';
      let content = prev ? prev.content : '';
      if (!prev || cmd === 'create' || cmd === 'rewrite') {
        if (typeof input.content === 'string') content = input.content;
      } else if (cmd === 'update') {
        if (typeof input.old_str === 'string' && input.old_str && content.includes(input.old_str)) {
          content = content.replace(input.old_str, () => (typeof input.new_str === 'string' ? input.new_str : ''));
        } else {
          ctx.warn(`Artifact "${(prev && prev.title) || id}": an update could not be applied (old_str not found).`);
        }
      }
      const a = {
        id,
        title: input.title || (prev && prev.title) || id,
        type: input.type || (prev && prev.type) || '',
        language: input.language || (prev && prev.language) || '',
        content,
        version: ((prev && prev.version) || 0) + 1,
      };
      artifacts.set(id, a);
      return a;
    };

    const artifactElement = (a) => {
      const map = ARTIFACT_TYPES[a.type] || { kind: 'artifact', language: null };
      const language = map.language || core.normalizeLang(a.language) || undefined;
      return {
        kind: map.kind,
        payload: a.content,
        language,
        title: `${a.title}${a.version > 1 ? ` (v${a.version})` : ''}`,
        origin: 'artifact',
        artifactType: a.type || undefined,
        artifactId: a.id,
      };
    };

    const fileElement = (f) => {
      const lang = core.langFromFilename(f.path);
      const kind = lang === 'mermaid' ? 'mermaid' : lang === 'svg' ? 'svg' : 'artifact';
      const name = f.path.split('/').pop();
      const stale = f.failedEdits ? ` — ⚠️ ${f.failedEdits} later edit(s) not replayable` : '';
      return {
        kind,
        payload: f.content,
        language: lang || undefined,
        title: `${name}${f.version > 1 ? ` (v${f.version})` : ''}${stale}`,
        origin: 'artifact',
        artifactType: 'file',
        artifactId: f.path,
      };
    };

    const chain = activeBranch(data);
    ctx.log(`Parsing ${chain.length} messages from the active branch…`, { pct: 40 });

    // Shared across messages: a tool result can arrive in a later "human" message (after approval).
    const toolSteps = new Map();

    chain.forEach((m, mi) => {
      const role = m.sender === 'human' ? 'user' : 'assistant';
      const protocol = isProtocolMessage(m);
      const turn = { role, elements: [], thinking: null, order: mi, protocol };
      const steps = [];
      const touched = new Map(); // key -> () => element
      const citations = new Map();

      const reference = (key, title, builder) => {
        if (!touched.has(key)) {
          turn.elements.push({
            kind: 'text',
            payload: `> 🧩 Artifact **${title}** — full source in *Extracted Widgets / Artifacts* below.`,
            origin: 'inline',
            isReference: true,
          });
        }
        touched.set(key, builder);
      };

      const pushText = (text) => {
        for (const part of splitLegacyTags(String(text || ''))) {
          if (part.type === 'text') {
            turn.elements.push(...core.splitMarkdown(part.text, { origin: 'inline' }));
          } else if (part.type === 'thinking') {
            steps.push({ type: 'thinking', label: '💭 Thinking', content: part.text });
          } else {
            const a = applyArtifact({
              command: 'create',
              id: part.attrs.identifier,
              type: part.attrs.type,
              title: part.attrs.title,
              language: part.attrs.language,
              content: part.content,
            });
            reference(`a:${a.id}`, a.title, () => artifactElement(artifacts.get(a.id)));
          }
        }
      };

      const blocks = Array.isArray(m.content) && m.content.length ? m.content : m.text ? [{ type: 'text', text: m.text }] : [];

      for (const b of blocks) {
        try {
          switch (b.type) {
            case 'text': {
              if (protocol) {
                steps.push({ type: 'approval', label: '🔐 User answered the tool approval request', content: '' });
                break;
              }
              pushText(b.text);
              for (const c of Array.isArray(b.citations) ? b.citations : []) {
                const url = c.url || (c.metadata && c.metadata.url) || (c.source && c.source.url);
                if (url && !citations.has(url)) citations.set(url, c.title || (c.metadata && c.metadata.title) || url);
              }
              break;
            }
            case 'thinking': {
              let content = typeof b.thinking === 'string' ? b.thinking : '';
              if (!content.trim() && Array.isArray(b.summaries) && b.summaries.length) {
                content = b.summaries
                  .map((s) => (s && (s.summary || s.text)) || '')
                  .filter(Boolean)
                  .map((s) => `- ${s}`)
                  .join('\n');
              }
              steps.push({ type: 'thinking', label: b.cut_off || b.truncated ? '💭 Thinking (truncated)' : '💭 Thinking', content });
              break;
            }
            case 'redacted_thinking':
              steps.push({ type: 'thinking', label: '💭 Thinking (redacted by provider)', content: '' });
              break;
            case 'tool_use': {
              const name = String(b.name || 'tool');
              const input = b.input && typeof b.input === 'object' ? b.input : {};
              if (name === 'web_search') {
                const step = { type: 'search', label: `🔎 Web search: ${input.query || ''}`.trim(), content: '' };
                steps.push(step);
                toolSteps.set(b.id, step);
              } else if (/^(web_fetch|webfetch)$/i.test(name)) {
                const step = { type: 'fetch', label: `🌐 Fetch: ${input.url || ''}`.trim(), content: input.prompt || '' };
                steps.push(step);
                toolSteps.set(b.id, step);
              } else if (name === 'artifacts') {
                const a = applyArtifact(input);
                reference(`a:${a.id}`, a.title, () => artifactElement(artifacts.get(a.id)));
              } else if (name === 'create_file' && typeof input.path === 'string') {
                const prev = files.get(input.path);
                files.set(input.path, { path: input.path, content: String(input.file_text || ''), version: ((prev && prev.version) || 0) + 1 });
                reference(`f:${input.path}`, input.path.split('/').pop(), () => fileElement(files.get(input.path)));
              } else if (name === 'str_replace' && typeof input.path === 'string' && files.has(input.path)) {
                const f = files.get(input.path);
                if (typeof input.old_str === 'string' && input.old_str && f.content.includes(input.old_str)) {
                  f.content = f.content.replace(input.old_str, () => String(input.new_str || ''));
                  f.version++;
                } else {
                  // Usually the file was changed by shell commands in Claude's sandbox, whose
                  // result is not part of the conversation: the exported copy may be outdated.
                  f.failedEdits = (f.failedEdits || 0) + 1;
                  ctx.warn(`File "${input.path.split('/').pop()}": an edit could not be replayed (file changed by shell commands); exported version may be outdated.`);
                }
                reference(`f:${input.path}`, input.path.split('/').pop(), () => fileElement(files.get(input.path)));
              } else if (/(^|:)show_widget$/.test(name) && typeof input.widget_code === 'string') {
                const code = input.widget_code;
                const isSvg = /^\s*<svg[\s>]/i.test(code);
                const title = input.title || 'Widget';
                turn.elements.push({
                  kind: 'text',
                  payload: `> 🧩 Widget **${title}** — full source in *Extracted Widgets / Artifacts* below.`,
                  origin: 'inline',
                  isReference: true,
                });
                turn.elements.push({
                  kind: isSvg ? 'svg' : 'artifact',
                  payload: code,
                  language: isSvg ? 'svg' : 'html',
                  title,
                  origin: 'tool',
                  artifactType: 'widget',
                });
              } else if (/(^|:)read_me$/.test(name)) {
                // Internal setup call of the visualizer, no user-facing content.
              } else {
                const step = {
                  type: 'tool',
                  label: `🛠️ ${name}${b.message ? ` — ${b.message}` : ''}`,
                  content: describeInput(core, name, input),
                };
                steps.push(step);
                toolSteps.set(b.id, step);
              }
              break;
            }
            case 'tool_result': {
              const name = String(b.name || '');
              if (SILENT_RESULT_TOOLS.test(name) && !b.is_error) break;
              const items = Array.isArray(b.content) ? b.content : typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : [];
              const links = items
                .filter((c) => c && c.type === 'knowledge' && c.url)
                .map((c) => `- [${String(c.title || c.url).replace(/[[\]]/g, '')}](${c.url})`);
              const texts = items.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text);
              let content = '';
              if (links.length) content = links.join('\n');
              else if (texts.length) content = core.fenced(truncate(texts.join('\n\n')), 'text');
              if (b.is_error && APPROVAL_PAUSE_RE.test(texts.join(' '))) content = '⏸ Paused: waiting for the user to approve this tool call.';
              else if (b.is_error) content = `⚠️ Tool error${content ? `:\n\n${content}` : ''}`;
              if (!content) break;
              const step = toolSteps.get(b.tool_use_id);
              if (step) step.content = [step.content, content].filter(Boolean).join('\n\n');
              else steps.push({ type: 'tool-result', label: `↳ ${name || 'tool'} result`, content });
              break;
            }
            default:
              break; // token_budget, voice_note, etc.
          }
        } catch (err) {
          ctx.warn(`Claude block "${b && b.type}" in message ${mi + 1} skipped: ${err.message}`);
        }
      }

      if (role === 'user') {
        for (const f of Array.isArray(m.files) ? m.files : []) {
          if (f && f.file_name) turn.elements.push({ kind: 'text', payload: `📎 ${f.file_name}${f.file_kind ? ` (${f.file_kind})` : ''}`, origin: 'inline' });
        }
        for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
          if (a && a.extracted_content) {
            turn.elements.push({
              kind: 'artifact',
              payload: a.extracted_content,
              language: core.langFromFilename(a.file_name) || 'text',
              title: a.file_name || 'attachment',
              origin: 'attachment',
            });
          }
        }
      }

      if (citations.size) {
        turn.elements.push({
          kind: 'text',
          payload: `**Sources:**\n${[...citations].map(([url, title]) => `- [${String(title).replace(/[[\]]/g, '')}](${url})`).join('\n')}`,
          origin: 'inline',
        });
      }
      for (const build of touched.values()) {
        try {
          const el = build();
          if (el && el.payload) turn.elements.push(el);
        } catch (err) {
          ctx.warn(`Artifact serialization failed: ${err.message}`);
        }
      }
      if (steps.length) turn.thinking = { steps };
      turns.push(turn);
    });

    return {
      title: data.name || getTitle(),
      model: data.model || undefined,
      method: 'api',
      turns: foldToolPauses(turns),
    };
  }

  /**
   * A tool approval splits one assistant answer into: assistant (paused) → human "(approval
   * answered)" → human [tool_result] → assistant (continuation). The UI shows a single answer,
   * so the protocol messages and the continuation are folded back into the paused turn.
   */
  function foldToolPauses(turns) {
    const absorb = (into, from) => {
      into.elements.push(...from.elements);
      const steps = [...((into.thinking && into.thinking.steps) || []), ...((from.thinking && from.thinking.steps) || [])];
      into.thinking = steps.length ? { steps } : null;
    };
    const out = [];
    let continuing = false;
    for (const t of turns) {
      const prev = out[out.length - 1];
      if (t.protocol && prev && prev.role === 'assistant') {
        absorb(prev, t);
        continuing = true;
        continue;
      }
      if (t.role === 'assistant' && continuing && prev && prev.role === 'assistant') {
        absorb(prev, t);
        continuing = false;
        continue;
      }
      continuing = false;
      out.push(t);
    }
    return out;
  }

  /* ----------------------------- DOM fallback ----------------------------- */

  const DOM_SKIP = '[data-testid="message-actions"], [data-testid="action-bar-retry"], [data-testid="action-bar-read-aloud"], .sr-only';

  function claudeToggles(ctx) {
    const core = ctx.core;
    return [...document.querySelectorAll('[data-testid="assistant-message"] button[aria-expanded="false"]')].filter(
      (b) => !ctx.clicked.has(b) && (b.hasAttribute('data-cds-row-toggle') || core.REASONING_TOGGLE_RE.test(core.shortText(b)) || /search|recherch|fetch|tool|outil|analy/i.test(core.shortText(b))),
    );
  }

  function assistantFromDom(asst, ctx) {
    const core = ctx.core;
    const steps = [];
    const exclude = new Set();
    for (const btn of asst.querySelectorAll('button[data-cds-row-toggle], button[aria-expanded="true"]')) {
      try {
        const label = core.shortText(btn, 100);
        const id = btn.getAttribute('aria-controls');
        let region = id ? document.getElementById(id) : null;
        if (!region) region = btn.parentElement && btn.parentElement.nextElementSibling;
        if (!region || exclude.has(region) || region.matches('.standard-markdown') || region.querySelector('.standard-markdown')) continue;
        exclude.add(region);
        const content = core.serializeToMarkdown(region, { skip: DOM_SKIP, warn: ctx.warn });
        if (content || label) steps.push({ type: 'thinking', label: `💭 ${label || 'Thinking'}`, content });
      } catch (err) {
        ctx.warn(`Claude thinking region skipped: ${err.message}`);
      }
    }
    const elements = [];
    const parts = [...asst.querySelectorAll('.standard-markdown, [class*="artifact-block"]')].filter(
      (el, _, all) => !all.some((o) => o !== el && o.contains(el)),
    );
    if (parts.length) {
      for (const p of parts) {
        if (p.matches('[class*="artifact-block"]')) {
          const title = core.shortText(p, 120);
          elements.push({ kind: 'text', payload: `> 🧩 Artifact: **${title}** (open it on claude.ai to copy its source; the API path captures it automatically)`, origin: 'inline' });
        } else {
          elements.push(...core.serialize(p, { skip: DOM_SKIP, warn: ctx.warn }));
        }
      }
    } else {
      elements.push(...core.serialize(asst, { skip: DOM_SKIP, warn: ctx.warn, exclude }));
    }
    return { elements, thinking: steps.length ? { steps } : null };
  }

  async function harvestDom(ctx) {
    const core = ctx.core;
    const list = document.querySelector('[data-testid="transcript-list"]');
    const anyMsg = document.querySelector('[data-testid="user-message"], [data-testid="assistant-message"]');
    if (!list && !anyMsg) throw new Error('No Claude conversation found in the page.');
    ctx.log('Falling back to DOM sweep (virtualized transcript)…', { pct: 15, level: 'warn' });
    const scroller = core.findScrollContainer(list || anyMsg);
    const ROW = '[data-testid="transcript-row"]';
    const count = () =>
      document.querySelectorAll(ROW).length || document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]').length;
    await core.loadAllHistory(scroller, ctx, count, { pctRange: [16, 22] });

    const collector = new core.TurnCollector();
    let expanded = 0;
    await core.sweep(
      scroller,
      ctx,
      async () => {
        if (ctx.options.includeThinking !== false) {
          const toggles = claudeToggles(ctx);
          if (toggles.length) {
            ctx.log(`Expanding thoughts (${toggles.length} found)…`);
            expanded += await core.expandToggles(toggles, ctx);
          }
        }
        const rows = [...document.querySelectorAll(ROW)];
        const units = rows.length ? rows : [...document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]')];
        const samples = [];
        for (const row of units) {
          try {
            const idx = row.getAttribute('data-index');
            const order = idx != null && idx !== '' ? Number(idx) : undefined;
            const user = row.matches('[data-testid="user-message"]') ? row : row.querySelector('[data-testid="user-message"]');
            const asst = row.matches('[data-testid="assistant-message"]') ? row : row.querySelector('[data-testid="assistant-message"]');
            const kind = row.getAttribute('data-perf-row');
            const keyBase = idx != null ? `row:${idx}` : `h:${core.hashString((row.textContent || '').slice(0, 400))}`;
            if (user || kind === 'human') {
              samples.push({ key: keyBase, turn: { role: 'user', elements: core.serialize(user || row, { skip: DOM_SKIP, warn: ctx.warn }), thinking: null, order } });
            } else if (asst || kind === 'assistant') {
              const { elements, thinking } = assistantFromDom(asst || row, ctx);
              samples.push({ key: keyBase, turn: { role: 'assistant', elements, thinking, order } });
            }
          } catch (err) {
            ctx.warn(`Claude row skipped: ${err.message}`);
          }
        }
        collector.ingest(samples);
      },
      { pctRange: [22, 92] },
    );
    ctx.log(`Collected ${collector.size} messages (${expanded} rows expanded).`, { pct: 93 });
    return { title: getTitle(), method: 'dom', turns: collector.turns() };
  }

  /* ------------------------------- Adapter -------------------------------- */

  LCH.adapters.claude = {
    id: 'claude',
    getTitle,
    async harvest(ctx) {
      const m = CHAT_RE.exec(location.pathname);
      if (m) {
        const res = await fetchConversation(ctx, m[1]);
        if (res && res.data) {
          try {
            ctx.log(`Conversation received (${res.source}, ${(res.data.chat_messages || []).length} messages in tree).`, { pct: 30 });
            const parsed = parseApi(res.data, ctx);
            if (parsed.turns.length) {
              ctx.log(`Parsed ${parsed.turns.length} turns from the API.`, { pct: 90 });
              return parsed;
            }
            ctx.warn('Claude API returned no messages; falling back to the DOM.');
          } catch (err) {
            ctx.warn(`Claude API parsing failed (${err.message}); falling back to the DOM.`);
          }
        }
      } else {
        ctx.warn('No /chat/<uuid> in the URL; the API path needs an open conversation. Trying the DOM.');
      }
      return harvestDom(ctx);
    },
  };
})();
