/*
 * LLM Context Harvester — popup controller.
 *
 * - Detects the platform of the active tab and makes sure the content scripts are present
 *   (tabs opened before the extension was installed/reloaded get them via chrome.scripting).
 * - Starts / stops a harvest and renders the live progress log streamed by the tab.
 * - Downloads (.md / .json) through chrome.downloads and copies Markdown to the clipboard.
 *   The result stays cached in the tab, so closing the popup mid-harvest loses nothing.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    title: $('tab-title'),
    platform: $('platform'),
    unsupported: $('unsupported'),
    app: $('app'),
    harvest: $('harvest'),
    abort: $('abort'),
    exportMd: $('export-md'),
    exportJson: $('export-json'),
    copyMd: $('copy-md'),
    optThinking: $('opt-thinking'),
    optAutoDl: $('opt-autodl'),
    progress: $('progress'),
    bar: $('bar'),
    summary: $('summary'),
    log: $('log'),
  };

  const PLATFORMS = { claude: 'Claude', gemini: 'Gemini', 'meta-ai': 'Meta AI' };
  const DEFAULT_OPTIONS = { includeThinking: true, autoDownload: true };

  let tab = null;
  let running = false;
  let hasResult = false;
  let pendingAction = null; // 'auto' | 'md' | 'json' | 'copy'
  let lastKey = null;

  const detectPlatform = (url) => {
    try {
      const h = new URL(url).hostname;
      if (h === 'claude.ai') return 'claude';
      if (h === 'gemini.google.com') return 'gemini';
      if (h === 'www.meta.ai' || h === 'meta.ai') return 'meta-ai';
    } catch {
      /* not a URL we can read */
    }
    return null;
  };

  const clock = (t) => new Date(t).toTimeString().slice(0, 8);

  function setProgress(pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
    ui.bar.style.width = `${v}%`;
    ui.progress.setAttribute('aria-valuenow', String(v));
  }

  function renderEntry(entry) {
    if (!entry) return;
    const li = document.createElement('li');
    li.className = entry.level || 'info';
    const time = document.createElement('time');
    time.textContent = clock(entry.t || Date.now());
    const span = document.createElement('span');
    span.textContent = entry.msg;
    li.append(time, span);
    const last = ui.log.lastElementChild;
    if (entry.key && last && lastKey === entry.key) ui.log.replaceChild(li, last);
    else ui.log.appendChild(li);
    lastKey = entry.key || null;
    ui.log.scrollTop = ui.log.scrollHeight;
    if (typeof entry.pct === 'number') setProgress(entry.pct);
  }

  const note = (level, msg) => renderEntry({ t: Date.now(), level, msg });

  function renderSummary(summary) {
    if (!summary) {
      ui.summary.hidden = true;
      return;
    }
    ui.summary.hidden = false;
    ui.summary.textContent = `${summary.partial ? 'Partial — ' : ''}${summary.text}${summary.warnings ? ` · ${summary.warnings} warning(s)` : ''}`;
  }

  function refreshButtons() {
    const supported = !!tab && !!detectPlatform(tab.url);
    ui.harvest.disabled = !supported || running;
    ui.harvest.textContent = running ? 'Harvesting…' : hasResult ? 'Harvest Again (MD + JSON)' : 'Harvest Conversation (MD + JSON)';
    ui.abort.hidden = !running;
    for (const b of [ui.exportMd, ui.exportJson, ui.copyMd]) b.disabled = !supported || running;
  }

  async function send(message) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async function ping(timeoutMs = 1200) {
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'LCH_PING' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
      return res && res.ok ? res : null;
    } catch {
      return null;
    }
  }

  /** Content scripts are not injected into tabs that were open before install/reload. */
  async function ensureInjected() {
    let pong = await ping();
    if (pong) return pong;
    note('info', 'Injecting the harvester into this already-open tab…');
    const scripts = chrome.runtime.getManifest().content_scripts || [];
    const main = scripts.find((c) => c.world === 'MAIN');
    const isolated = scripts.find((c) => c.world !== 'MAIN');
    if (main) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: main.js, world: 'MAIN', injectImmediately: true });
    }
    if (isolated) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: isolated.js, world: 'ISOLATED' });
    }
    pong = await ping(2500);
    if (!pong) throw new Error('The page did not answer after injection. Reload the tab and try again.');
    note('success', 'Harvester injected.');
    return pong;
  }

  async function getResult() {
    const res = await send({ type: 'LCH_GET_RESULT' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No harvest result available.');
    return res;
  }

  async function downloadText(text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    try {
      await chrome.downloads.download({
        url,
        filename: `LLM-Context-Harvester/${filename}`,
        saveAs: false,
        conflictAction: 'uniquify',
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async function exportFormats(formats) {
    const r = await getResult();
    for (const f of formats) {
      if (f === 'md') {
        await downloadText(r.markdown, `${r.filenameBase}.md`, 'text/markdown');
        note('success', `Downloaded ${r.filenameBase}.md`);
      } else {
        await downloadText(r.json, `${r.filenameBase}.json`, 'application/json');
        note('success', `Downloaded ${r.filenameBase}.json`);
      }
    }
  }

  async function copyMarkdown() {
    const r = await getResult();
    try {
      await navigator.clipboard.writeText(r.markdown);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = r.markdown;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('Clipboard write was refused by the browser.');
    }
    note('success', `Markdown copied to clipboard (${r.markdown.length.toLocaleString()} chars).`);
  }

  async function runAction(action) {
    try {
      if (action === 'md') await exportFormats(['md']);
      else if (action === 'json') await exportFormats(['json']);
      else if (action === 'copy') await copyMarkdown();
      else if (action === 'auto') {
        if (ui.optAutoDl.checked) await exportFormats(['md', 'json']);
        else note('info', 'Result ready — use the export buttons.');
      }
    } catch (err) {
      note('error', err.message);
    }
  }

  async function startHarvest(action) {
    if (running) return;
    pendingAction = action;
    ui.log.textContent = '';
    lastKey = null;
    setProgress(0);
    renderSummary(null);
    const res = await send({ type: 'LCH_START', options: { includeThinking: ui.optThinking.checked } });
    if (!res || !res.started) {
      note('error', (res && (res.reason || res.error)) || 'Could not start the harvest.');
      pendingAction = null;
      return;
    }
    running = true;
    refreshButtons();
  }

  async function onDone(msg) {
    running = false;
    if (msg.ok) {
      hasResult = true;
      renderSummary(msg.summary);
      setProgress(100);
      const action = pendingAction;
      pendingAction = null;
      if (action) await runAction(action);
    } else {
      pendingAction = null;
    }
    refreshButtons();
  }

  function onRuntimeMessage(msg, sender) {
    if (!tab || !sender || !sender.tab || sender.tab.id !== tab.id || !msg) return;
    if (msg.type === 'LCH_PROGRESS') renderEntry(msg.entry);
    else if (msg.type === 'LCH_DONE') onDone(msg);
  }

  async function onExport(action) {
    if (running) return;
    if (hasResult) {
      const st = await send({ type: 'LCH_STATUS' });
      if (st && st.hasResult) {
        await runAction(action);
        return;
      }
      hasResult = false;
    }
    await startHarvest(action);
  }

  async function saveOptions() {
    try {
      await chrome.storage.local.set({ includeThinking: ui.optThinking.checked, autoDownload: ui.optAutoDl.checked });
    } catch {
      /* storage unavailable, keep in-memory */
    }
  }

  async function init() {
    try {
      const opts = await chrome.storage.local.get(DEFAULT_OPTIONS);
      ui.optThinking.checked = opts.includeThinking !== false;
      ui.optAutoDl.checked = opts.autoDownload !== false;
    } catch {
      /* defaults */
    }
    ui.optThinking.addEventListener('change', saveOptions);
    ui.optAutoDl.addEventListener('change', saveOptions);

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const platform = tab && detectPlatform(tab.url);
    ui.title.textContent = (tab && tab.title) || 'No active tab';
    if (!platform) {
      ui.unsupported.hidden = false;
      ui.app.hidden = true;
      ui.platform.textContent = 'Unsupported';
      return;
    }
    ui.platform.textContent = PLATFORMS[platform];
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    ui.harvest.addEventListener('click', () => startHarvest('auto'));
    ui.abort.addEventListener('click', async () => {
      await send({ type: 'LCH_ABORT' });
      note('warn', 'Stopping… the partial result will be exported.');
    });
    ui.exportMd.addEventListener('click', () => onExport('md'));
    ui.exportJson.addEventListener('click', () => onExport('json'));
    ui.copyMd.addEventListener('click', () => onExport('copy'));
    refreshButtons();

    try {
      const pong = await ensureInjected();
      if (pong.title) ui.title.textContent = pong.title;
      const st = pong.status || {};
      for (const entry of st.log || []) renderEntry(entry);
      if (typeof st.pct === 'number') setProgress(st.pct);
      running = !!st.running;
      hasResult = !!st.hasResult;
      if (hasResult) renderSummary(st.summary);
      if (running) {
        pendingAction = 'auto';
        note('info', 'A harvest is already running on this tab — following its progress.');
      }
    } catch (err) {
      note('error', `Cannot reach the page: ${err.message}`);
      ui.harvest.disabled = true;
      return;
    }
    refreshButtons();
  }

  init().catch((err) => note('error', err.message));
})();
