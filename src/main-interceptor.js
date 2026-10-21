/*
 * LLM Context Harvester — MAIN world script.
 *
 * Runs in the page's own JavaScript context (same cookies, same fetch as the web app).
 *  - Passive fetch hook: caches Claude conversation JSON the app itself downloads.
 *  - Active fetcher: on '__TRIGGER_CLAUDE_FETCH__' (sent by the ISOLATED orchestrator),
 *    calls the Claude conversation API for the conversation in the current URL and
 *    answers with '__CLAUDE_FETCH_RESULT__'.
 *  - Gemini Canvas reader: on '__LCH_GEMINI_CANVAS__', returns the full source of the
 *    Monaco editor(s) of the open canvas panel ('__LCH_GEMINI_CANVAS_RESULT__').
 *
 * Every payload crossing the MAIN <-> ISOLATED boundary is a JSON string, because object
 * `detail` values are not reliably readable from the other world.
 */
(() => {
  'use strict';

  const FLAG = '__LCH_MAIN_INSTALLED__';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const EVT = {
    PING: '__LCH_MAIN_PING__',
    PONG: '__LCH_MAIN_PONG__',
    TRIGGER: '__TRIGGER_CLAUDE_FETCH__',
    RESULT: '__CLAUDE_FETCH_RESULT__',
  };

  const reply = (name, payload) => {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent(name, {
          detail: JSON.stringify({ requestId: payload && payload.requestId, ok: false, error: `Serialization failed: ${err.message}` }),
        }),
      );
    }
  };

  const parseDetail = (ev) => {
    try {
      return typeof ev.detail === 'string' ? JSON.parse(ev.detail) : {};
    } catch {
      return {};
    }
  };

  window.addEventListener(EVT.PING, (ev) => {
    const req = parseDetail(ev);
    reply(EVT.PONG, { requestId: req.requestId, ok: true, host: location.hostname });
  });

  /*
   * Gemini Canvas: the code canvas is a Monaco editor whose DOM only renders visible lines,
   * but the page exposes `window.monaco`, whose models hold the full source. The ISOLATED
   * world cannot see page globals, so it asks here after opening a canvas panel.
   */
  if (location.hostname === 'gemini.google.com') {
    window.addEventListener('__LCH_GEMINI_CANVAS__', (ev) => {
      const req = parseDetail(ev);
      const requestId = req.requestId;
      try {
        const monaco = window.monaco;
        if (!monaco || !monaco.editor) {
          reply('__LCH_GEMINI_CANVAS_RESULT__', { requestId, ok: false, error: 'Monaco editor API not exposed by the page' });
          return;
        }
        const editors = typeof monaco.editor.getEditors === 'function' ? monaco.editor.getEditors() : [];
        const seen = new Set();
        const out = [];
        for (const ed of editors) {
          const model = ed.getModel && ed.getModel();
          const node = ed.getContainerDomNode && ed.getContainerDomNode();
          if (!model || !node || !node.isConnected) continue;
          const uri = String(model.uri);
          if (seen.has(uri)) continue;
          seen.add(uri);
          out.push({
            uri,
            language: model.getLanguageId(),
            value: model.getValue(),
            inPanel: !!node.closest('code-immersive-panel, immersive-panel'),
          });
        }
        reply('__LCH_GEMINI_CANVAS_RESULT__', { requestId, ok: true, editors: out });
      } catch (err) {
        reply('__LCH_GEMINI_CANVAS_RESULT__', { requestId, ok: false, error: err.message });
      }
    });
    return;
  }

  // Only claude.ai needs the fetch hook and the API fetcher.
  if (location.hostname !== 'claude.ai') return;

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const CONV_API_RE = new RegExp(`/api/organizations/(${UUID})/chat_conversations/(${UUID})(?:[?#]|$)`, 'i');
  const CHAT_PATH_RE = new RegExp(`/chat/(${UUID})`, 'i');

  /** convId -> { orgId, data, ts } */
  const passiveCache = new Map();
  const nativeFetch = window.fetch;

  const requestUrl = (input) => {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch {
      /* ignore */
    }
    return '';
  };

  window.fetch = function lchFetchHook(...args) {
    const promise = nativeFetch.apply(window, args);
    try {
      const match = CONV_API_RE.exec(requestUrl(args[0]));
      if (match) {
        promise
          .then((res) => {
            if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) return;
            res
              .clone()
              .json()
              .then((data) => {
                if (!data || !Array.isArray(data.chat_messages)) return;
                const prev = passiveCache.get(match[2]);
                if (!prev || data.chat_messages.length >= prev.data.chat_messages.length) {
                  passiveCache.set(match[2], { orgId: match[1], data, ts: Date.now() });
                }
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      /* never break the page's fetch */
    }
    return promise;
  };

  const getJSON = async (url) => {
    const res = await nativeFetch.call(window, url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url.split('?')[0]}`);
    return res.json();
  };

  const cookieOrgId = () => {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const conversationUrl = (orgId, convId) =>
    `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`;

  async function fetchConversation(convId) {
    const errors = [];
    const tried = new Set();
    const attempt = async (orgId) => {
      if (!orgId || tried.has(orgId)) return null;
      tried.add(orgId);
      try {
        const data = await getJSON(conversationUrl(orgId, convId));
        if (data && Array.isArray(data.chat_messages)) return { orgId, data };
        errors.push(`org ${orgId.slice(0, 8)}: unexpected payload`);
      } catch (err) {
        errors.push(`org ${orgId.slice(0, 8)}: ${err.message}`);
      }
      return null;
    };

    const fromCookie = await attempt(cookieOrgId());
    if (fromCookie) return fromCookie;

    let orgs = [];
    try {
      orgs = await getJSON('/api/organizations');
    } catch (err) {
      errors.push(`organizations: ${err.message}`);
    }
    if (Array.isArray(orgs)) {
      const chatFirst = [...orgs].sort((a, b) => {
        const ca = Array.isArray(a.capabilities) && a.capabilities.includes('chat') ? 0 : 1;
        const cb = Array.isArray(b.capabilities) && b.capabilities.includes('chat') ? 0 : 1;
        return ca - cb;
      });
      for (const org of chatFirst) {
        const found = await attempt(org && org.uuid);
        if (found) return found;
      }
    }
    throw new Error(errors.join(' | ') || 'No organization could serve this conversation');
  }

  window.addEventListener(EVT.TRIGGER, async (ev) => {
    const req = parseDetail(ev);
    const requestId = req.requestId;
    const m = CHAT_PATH_RE.exec(location.pathname);
    if (!m) {
      reply(EVT.RESULT, { requestId, ok: false, error: 'No conversation id in the URL (expected /chat/<uuid>)' });
      return;
    }
    const convId = m[1];
    try {
      const { orgId, data } = await fetchConversation(convId);
      reply(EVT.RESULT, { requestId, ok: true, source: 'active-api', orgId, data });
    } catch (err) {
      const cached = passiveCache.get(convId);
      if (cached) {
        reply(EVT.RESULT, {
          requestId,
          ok: true,
          source: 'passive-cache',
          orgId: cached.orgId,
          data: cached.data,
          warning: err.message,
        });
      } else {
        reply(EVT.RESULT, { requestId, ok: false, error: err.message });
      }
    }
  });
})();
