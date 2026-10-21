# Privacy Policy — LLM Context Harvester

Last updated: 2026-10-21

LLM Context Harvester runs entirely in your browser.

- It reads the content of the Claude, Gemini or Meta AI conversation open in the current tab, only when you click **Harvest** or an export button.
- The exported Markdown and JSON files are created locally and saved to your Downloads folder, or copied to your clipboard when you ask for it.
- No data is collected, stored on a server, sold, shared or sent to the developer or any third party. There are no analytics and no remote code.
- On claude.ai, the extension calls Claude's own conversation endpoint from the page, with your existing session, to read the open conversation. Nothing leaves your browser beyond that request to claude.ai.
- Your two popup preferences (include reasoning, auto-download) are kept in `chrome.storage.local` on your device.

Contact: open an issue at https://github.com/Kubyer/llm-context-harvester/issues
