Forbes Travel Guide – Brand Store Form (2026)

Overview
- Dual-mode form with:
	- Redemption Code Lookup: populates fields from an 8-character code.
	- Establishment Name Lookup: Bootstrap 5 Autocomplete against Airtable via a proxy.

Files
- autocomplete.min.js – Bootstrap 5 Autocomplete (minified).
- main.js – Lightweight controller for field wiring, proxy fetch, caching, and UI feedback.

Quick start
1) Include both scripts on the page (autocomplete first), then load the form markup that uses .form-item wrappers.
2) Optionally configure without editing code:
	 <script>
	 window.FTG_CONFIG = {
		 AIRTABLE_BASE_ID: 'your_base_id',
		 AIRTABLE_TABLE: 'your_table_id',
		 AIRTABLE_PROXY_URL: 'https://your-proxy.example.com/api/query',
		 DEBUG: false
	 };
	 </script>
3) The script self-initializes on DOM ready. You can control it via window.FTGForm:
	 - FTGForm.reset()
	 - FTGForm.reinitialize()
	 - FTGForm.setMode('Redemption Code Lookup' | 'Establishment Name Lookup')

Project cleanup and simplification roadmap
Short term (safe, low-risk)
- Centralize config (done) using window.FTG_CONFIG.
- Expose a tiny public API for scripted resets/mode changes (done).
- Remove console noise in production via DEBUG flag (done; also set window.FTG_DEBUG=true to see verbose logs).
- Keep autocomplete data mapping minimal; only map used fields.

Medium term
- Split main.js into modules:
	- config.js, fields.js, ui.js (spinners/messages), data.js (proxy + cache), app.js (bootstrap/init).
- Replace alert() mismatch notices with inline help only, to avoid blocking UX.
- Add basic smoke tests for setSelectValue and queryAirtableContains using a tiny test harness.
- Gate jQuery-only code paths (Select2) behind feature detection and avoid binding duplicate listeners.

Long term
- Convert to TypeScript for typed field maps and safer refactors.
- Bundle with Vite (single IIFE output), create a versioned dist/ folder.
- Replace window globals with a constructor pattern (new FTGFormController(el, config)).
- Add E2E test for autocomplete happy path and code lookup with mock server.

Troubleshooting
- Autocomplete not appearing: ensure autocomplete.min.js loads before main.js and window.Autocomplete exists.
- No results: confirm the proxy URL and that it returns records with fields. Use DEBUG=true to see fetch logs.
- Select2 not disabling: ensure the select has been enhanced; fallback CSS disable is applied otherwise.

License
- Autocomplete library is MIT per its source header. App glue code is proprietary to the project owner.

