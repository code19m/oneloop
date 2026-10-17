# Frontend

The Rust binary serves these files directly, with URL paths matching this tree
and no bundler.

```text
index.html  Application entry and SPA fallback
src/        ES modules for app setup, auth, data and features
views/      The view layer: the app.js shell and the feature modules in app/
styles/     CSS and grain texture
icons/      Favicons and app icons
vendor/     Browser libraries, licenses and audit records
tests/      Unit tests mirroring src/ and views/; support/ has the jsdom harness
            (dom.cjs) and helpers that need no DOM (helpers.cjs)
```

## Where new code goes

A new page or feature goes in `src/features/<name>/` with its markup, as
Knowledge does. Change `views/` only for the pages it already draws. Other
application logic goes in `src/` as ES modules with JSDoc types. Whole-app
browser journeys live in [`../e2e/journeys/`](../e2e/README.md).

- **Views.** `views/app.js` is the shell: routing, the render pipeline and the
  pages that have no module of their own. Each feature in `views/app/` keeps
  its markup and its `App` handlers together: `board.js`, `roadmap.js`,
  `pool.js`, `task.js` (a task's page), `attachments.js`, `collaboration.js`
  (comments and the Inbox), `account.js` (Profile, Users and Settings),
  `storage.js`, `dialogs.js`, `overlays.js` (popovers, menus, dialogs and
  focus return), `controls.js` (selects, date fields, input cleaning),
  `forms.js`, `toasts.js` and `drag.js`. They share `model.js` (view state
  and data lookups) and `format.js` (text, dates and icons), animate with the
  one motion engine, `UIMotion` from `src/app/motion.js`, and redraw a list in
  place with `src/app/rows.js`, so focus and a pressed button survive. A
  module reaches the render pipeline through `App`, such as `App.refresh()`,
  and never imports `views/app.js`. Views may import from `src/`, but not the
  other way round: only boot.js loads `views/app.js`. The views are untyped.
  tsc reaches them through boot.js, so each starts with `// @ts-nocheck`.
- **Actions.** The view bridge, `src/app/view-bridge.js`, adds the
  server-backed `App` methods, such as `saveTask`, and wraps a few of the
  views' own, such as `nav`. To change an action that saves, start from its
  feature's module in `src/app/bridge/`: `tasks.js`, `checklist.js`,
  `roadmap.js`, `pool.js`, `projects.js`, `account.js` or `route.js` (page
  changes). They share `commands.js`, which runs a command and resolves its
  conflicts, and `saves.js`, which saves one record at a time and keeps a task
  field's draft.
  `views/app/collaboration.js` and `views/app/attachments.js` add the comment
  and attachment actions.
- **Event handlers.** Markup has no inline event handlers. An element names the
  `App` method that its click runs in `data-action`, or that another event runs
  in `data-action-<event>`, with JSON arguments in `data-args`. Write these
  with `UIAction` from `src/app/markup.js`, such as `UIAction('openTask', id)`
  or `UIAction.on('keydown', 'epicKey', UIAction.event, id)`, and escape text
  with its `escapeHtml`.
  `src/app/view-actions.js` runs them from listeners on the document, but never
  inside rendered Markdown or file previews, and only for the names in its
  `ACTIONS` list. A new action goes into that list; a test checks that the list
  matches the markup and that each name is an existing method.
- **Unsaved input.** Before someone leaves a page, `hasUnsavedInput` in the
  recovery controller looks for changed fields in open editors. Mark a field
  that saves itself when it loses focus with `data-autosave`, so it counts only
  while it is being typed. One whose save was refused gets `data-unsaved` and
  counts until it saves. Text kept outside open editors, such as a task
  field's draft, counts through `recovery.trackUnsaved(check, forget)`:
  `forget` drops it when its person signs out on purpose, while a session that
  ends by itself keeps it for their next sign-in.
- **Cmd/Ctrl+S.** `src/app/save-shortcut.js` saves a `data-autosave` field
  through its blur action and keeps focus there. Mark a dialog's form or an
  editor with `data-save-shortcut` so the key presses its `.btn.primary`, and
  a button so the key presses it when nothing is being edited. Leave forms
  that send, sign in or confirm unmarked.
- **Tooltips.** Put a detail that only a hover would show, such as a full time
  or a name that may be cut off, in `data-tip` rather than `title`.
  [`src/app/tooltips.js`](src/app/tooltips.js) shows it and lists the other
  `data-tip-*` attributes. Don't make an element focusable just for its tip,
  because a long list would gain a Tab stop per row. Give screen readers the
  detail through the row's name or description instead, as the Board card
  does for a Blocked reason.

The page's Content-Security-Policy enforces Trusted Types and refuses inline
`<style>` elements:

- Write HTML with `setTrustedHTML` from `src/app/trusted-types.js`, which goes
  through the app's `oneloop` policy. A plain string passed to `innerHTML`,
  `srcdoc` or `DOMParser` is refused.
- Load scripts only from `src/`, `views/` and `vendor/`.
- Style with the CSS files and `style` attributes, not `<style>` elements.

Mermaid writes inline styles and HTML strings, so it lays out diagrams in
`views/diagram-renderer.html`, a separate document with its own policy, and the
page shows each result as an image.

## How it loads

`theme.js` runs in the document head. `src/app/main.js` starts `boot.js`, which
sets up the data, the controllers and the document's listeners, then imports
the `app.js` module. The view bridge installs server-backed actions before the
first application render; preview libraries load on demand.

`index.html` preloads every module that start-up imports, so the browser
fetches them at once instead of one import level at a time. A new module that
`boot.js` or `app.js` imports needs a link there; `tests/index.test.js` lists
any that is missing or left over.

The page's parts reach each other through these `window` properties only.
New code imports a module instead of adding one.

| Global | Set by | Holds |
| --- | --- | --- |
| `DATA` | `boot.js` | The projection that the views draw |
| `App` | `views/app.js` | The view actions and refresh methods |
| `OneloopRuntime` | `boot.js` | The view bridge's server-backed functions, the server clock, and the API, commands and live updates |
| `Recovery` | `boot.js` | Connection, conflict and unsaved-input handling |
| `ONELOOP_BUILD` | `boot.js` | The server's version |
| `OneloopCollaboration`, `OneloopKnowledge` | their controllers in `src/features/` | Comments, the Inbox and live updates; Knowledge |
| `Theme` | `views/theme.js` | The color theme |

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
