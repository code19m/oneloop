# Frontend

The Rust binary serves these files directly, with URL paths matching this tree and no bundler.

```text
index.html  Application entry and SPA fallback
src/        ES modules for app setup, auth, data and features
views/      Older classic-script view layer
styles/     CSS and grain texture
icons/      Favicons and app icons
vendor/     Browser libraries, licenses and audit records
tests/      Unit tests mirroring src/ and views/, with a shared jsdom harness
```

## Where new code goes

Add application logic to `src/` as ES modules with JSDoc types; preserve the DOM contracts in `views/`.
Whole-app browser journeys live in [`../e2e/journeys/`](../e2e/README.md).

To change an action, start from `src/app/view-bridge.js`: it replaces many `App` methods in `views/app.js` with server-backed versions, so the method in `views/` may not be the one that runs.
Inline handlers in `views/` templates only reach methods listed in `ALLOWED_APP_METHODS` (`src/app/view-events.js`); a new one needs an entry there and a test.
Before someone leaves a page, `hasUnsavedInput` in the recovery controller looks for changed fields in open editors. Mark a field that saves itself when it loses focus with `data-autosave`, so it counts only while it is being typed.

The page's Content-Security-Policy enforces Trusted Types and refuses inline `<style>` elements:

- Write HTML with `UIHTML` (`setHTML` in `views/app.js`), which goes through the app's `oneloop` policy. A plain string passed to `innerHTML`, `srcdoc` or `DOMParser` is refused.
- Load scripts only from `src/`, `views/` and `vendor/`.
- Style with the CSS files and `style` attributes, not `<style>` elements.

Mermaid writes inline styles and HTML strings, so it lays out diagrams in `views/diagram-renderer.html`, a separate document with its own policy, and the page shows each result as an image.

## How it loads

`theme.js` runs in the document head; `src/app/main.js` starts `boot.js`, which loads motion, SHA-256, activity, file views, uploads and collaboration in order, then `app.js`.
The view bridge installs server-backed actions before the first application render; preview libraries load on demand.

## Design

The shipped app is the design reference. `styles/style.css` defines the tokens
as custom properties on `:root` (dark) and `:root[data-theme="light"]`; use
them rather than literal values, and check both themes.

- **Type**: the system UI font (`--font-sans`) and system monospace for task
  IDs (`--font-mono`). Sizes run from `--text-xs` (12 px) to `--text-heading`
  (18 px); nothing smaller than 12 px.
- **Surfaces**: `--surface-canvas`, `--surface-sidebar`, `--surface-raised`
  and `--surface-control`, with `--text-primary`, `--text-secondary` and
  `--text-tertiary` on top. Glass (`--surface-glass`) is only for the sidebar,
  menus, dialogs and drawers.
- **Status colors**: `--run` (In Progress), `--review` (In Review), `--ok`
  (Done), `--warn` (Today, caution) and `--err` (errors, destructive actions).
  Each status also has its own ring icon, so color is never the only cue.
- **Shape**: radii from `--radius-xs` to `--radius-lg`; buttons are pills
  `--button-height` tall (`--button-dialog-height` in dialogs).
- **Motion**: short transitions (about 120–180 ms), no lift or glow on hover,
  and nothing nonessential under `prefers-reduced-motion` or
  `prefers-reduced-transparency`.
- **Controls**: custom selects, pickers and date fields rather than native
  ones, with visible focus, Escape to close and focus returned to the opener.
- **Copy**: short labels and actionable errors. Mark optional fields as
  Optional instead of starring required ones, and don't add explanatory or
  tutorial text to the interface.

## Checks

```sh
npm ci && npm run typecheck && npm run lint && npm test
```
