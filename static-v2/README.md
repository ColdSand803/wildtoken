# WildToken Admin UI v2

Dark OLED ops console rewrite. Lives alongside the original `static/` UI.

## Preview

Serve the backend as usual, then open the v2 admin route once wired (e.g. `/admin-v2` or static mount of `static-v2/`).

Local static check (any static server from repo root):

```bash
# example
python -m http.server 8765
# open http://localhost:8765/static-v2/admin.html
```

API calls still go to `/api/admin/*` on the same origin. Without a backend, data loads will fail; layout and dialogs still render.

## Paths

| Asset | URL |
|-------|-----|
| Page | `/static-v2/admin.html` |
| Styles | `/static-v2/styles.css` |
| Script | `/static-v2/admin.js` |
| Favicon | `/static-v2/favicon.svg` |

## Compatibility

Element **IDs**, `data-view` / `data-field`, and JS-facing **class names** match the original `static/admin.js` contract. Do not rename IDs or remove hooks used by runtime-generated markup.

Orchestrator should mount `static-v2` and expose an admin-v2 entry; leave `static/` untouched.
