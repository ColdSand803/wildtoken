# Ark Complex Theme Design

## Decision

Add `ark` as a selectable WildToken Admin theme. The theme uses the Ark family’s original black, off-white, and cyan industrial-information grammar at depth `3 / complex`.

The user explicitly selected this alternative to the existing `endfield / complex` theme. It must be visually distinct from both the current glassy cyan default and the pale, signal-yellow Endfield field system.

## Design contract

- **Family:** `ark`
- **Depth:** `complex`
- **Evidence pattern:** a black edge shell, cyan active rules, indexed operational stages, sparse blueprint rules, and real state-led instrumentation.
- **Primary task:** let an administrator inspect routing and runtime state, reach channels and logs quickly, and act on tokens or settings without decorative interference.

## Scope

The static, dependency-free frontend will gain one stylesheet and three small integration changes:

1. Register `ark` in the pre-paint theme whitelist and runtime theme registry.
2. Apply `data-ark-theme="ark"` and `data-ark-depth="complex"` whenever it is selected.
3. Add `static/css/ark.css` after existing theme imports.
4. Add a Node static-contract test, and run it in the existing CI frontend-check step.

No API route, database model, user copy, or semantic DOM structure changes are in scope.

## Visual system

### Desktop

- Use a narrow black left rail for navigation and compact utility controls.
- Keep the main stage wide and dark, with a sparse grid, one directional sector, page indices, and cyan only for selection, focus, progress, or the primary action.
- Treat Dashboard, Channels, Logs, Tokens, and Settings as five real operational zones. Preserve their existing data, tables, forms, dialogs, and labels.
- Use square or 2px controls, 1px rules, compact technical micro-labels, and a large page index. Do not add fake metrics, protocol codes, or decorative HUD data.

### Mobile and accessibility

- Recompose the rail into a compact header plus fixed five-item bottom navigation.
- Keep theme and density choices available through Settings while space-constrained top-bar utilities remain hidden.
- Preserve semantic buttons, labels, dialogs, and existing keyboard behavior.
- Give focus a visible cyan ring and disable reveal/pulse animations under `prefers-reduced-motion`.

## Acceptance criteria

- Selecting Ark persists through `localStorage`, applies both Ark root attributes before paint, and has an accessible menu entry.
- Desktop has an Ark-specific multi-zone shell and meaningful stage layers.
- Mobile is re-laid out rather than a scaled desktop rail.
- Shared controls, tables, code frames, status states, and dialogs retain readable contrast and clear focus.
- The existing Endfield behavior remains unchanged.
- The static contract test, JavaScript syntax checks, Ark heuristic audit, Rust formatting, Clippy, and tests pass.
