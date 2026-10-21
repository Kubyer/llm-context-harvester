# LLM Context Harvester

Chrome extension (Manifest V3, vanilla JS, **zero build**) that exports a full conversation from **Claude**, **Gemini** and **Meta AI** to **Markdown** (ready for an LLM agent) and a **unified JSON**, in one click.

Copy-pasting an AI chat loses half of it. This keeps:

- every `user` / `assistant` message, in order, through virtual scrolling and lazy-loaded history;
- reasoning: Claude thinking (or its summaries when the raw text is hidden), Gemini thoughts, Meta AI's "Show thinking" panel (steps + sources), web searches and tool calls;
- code blocks with their language and without UI labels ("Copy code"…), Gemini code-execution output;
- KaTeX math as `$…$` / `$$…$$` (no duplicated rendering), tables as Markdown, SVG diagrams (not icons), Mermaid, ASCII diagrams;
- **Claude artifacts**: final version rebuilt from `create` → `update`/`rewrite`, files written by Claude, SVG/HTML widgets;
- **Gemini Canvas**: full source read from the panel's Monaco editor.

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select the cloned folder.
4. Pin the extension.

Tabs that were already open work without a reload: if the page does not answer, the popup injects the scripts with `chrome.scripting`.

## Use

1. Open a conversation (claude.ai/chat/…, gemini.google.com/app/…, meta.ai/prompt/…).
2. Click the extension → **Harvest Conversation (MD + JSON)**.
3. Watch the live log (history loading, scroll %, thoughts expanded, serialization). Both files land in `~/Downloads/LLM-Context-Harvester/` as `<platform>-<title>-<timestamp>`.
4. **Export Markdown (.md)**, **Export Unified JSON (.json)** and **Copy Markdown to Clipboard** reuse the last result, or run a harvest if there is none.

You can close the popup during a harvest: the result stays in the tab and shows up when you reopen it. **Stop & keep partial result** exports what was collected so far. While it runs, the page scrolls and panels open and close on their own; leave the tab alone until the log says "Ready!".

## How each site is read

| Platform | Strategy |
| --- | --- |
| Claude | Claude's own conversation API from the page context (`tree=True`, active branch from `current_leaf_message_uuid`); tool-approval pauses are folded back into one answer. DOM sweep fallback. |
| Gemini | Loads the full history, sweeps the chat, expands thoughts, opens each Canvas and reads its Monaco model, closes it. |
| Meta AI | Loads the full history, sweeps the chat, opens each reasoning side panel (Steps, then Sources) and closes it; unwraps `l.meta.ai` redirect links. |

## Output

Markdown:

```
---
platform: claude
title: "…"
url: "…"
extracted_at: "…"
turn_count: 8
extraction_method: api
---

# Conversation: … (Platform: Claude)

## Turn 1 — USER
## Turn 2 — ASSISTANT (Claude)
### 🧠 Thinking / Reasoning Trace
### 💬 Response
### 🧩 Extracted Widgets / Artifacts
```

JSON (`UnifiedLLMTranscript`): `metadata` (`exportId`, `platform`, `conversationTitle`, `url`, `extractedAt`, `extractionMethod`, `turnCount`, `warnings`) and `turns[]` (`index`, `role`, `thinking: { trace, steps[] }`, `elements[]` with `kind` = `text | code | svg | mermaid | table | artifact`, `payload`, `language`, `title`, `origin`).

## Layout

```
manifest.json
popup/                        UI, injection into open tabs, downloads, clipboard
src/main-interceptor.js       MAIN world: fetch hook + Claude API call, Monaco reader (Gemini Canvas)
src/isolated-orchestrator.js  ISOLATED world: messaging, MAIN bridge, sweep, serializer, MD/JSON builders
src/adapters/claude.js        API (full tree, active branch) → DOM fallback
src/adapters/gemini.js        history + sweep + thoughts + Canvas
src/adapters/meta.js          history + sweep + reasoning side panel
```

- No ES modules: the ISOLATED files share one `content_scripts` entry and register on `globalThis.__LCH__`.
- MAIN ↔ ISOLATED bridge: `CustomEvent`s whose `detail` is a JSON string, matched by `requestId`. The MAIN world only fetches the conversation in the current URL.
- Downloads happen in the popup (`chrome.downloads` is not available to content scripts).
- Every node, block and turn is parsed inside `try/catch`; failures become warnings (end of the Markdown, `metadata.warnings`) and never kill the export.

If a site changes its DOM, start with the `SEL` / `SKIP` objects at the top of the matching adapter.

## Known limits

- **Claude**: most reasoning comes as Claude's own summaries (raw thinking is hidden). Files Claude edited with shell commands in its sandbox cannot be replayed; the export keeps the last rebuildable version, flagged "⚠️ N later edit(s) not replayable".
- **Gemini**: once an answer is complete, Gemini no longer shows its reasoning; those turns are flagged "Reasoning used — trace not exposed by Gemini". Sources keep their name only (`[source: …]`), URLs are not in the page. Mini-apps (interactive visuals) run in a sandboxed iframe and are referenced without code. Code-execution output is tagged `title: "Execution output"` so it can be filtered.
- Rendered previews (Canvas, HTML artifacts) live in cross-origin iframes: the source is exported, not the render.
- Button labels are matched in English and French.
