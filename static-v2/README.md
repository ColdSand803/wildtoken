# WildToken Admin (v2 / default)

Dark OLED ops console generated from `design-system/wildtoken/MASTER.md` (ui-ux-pro-max).

## Routes

| URL | Asset |
|-----|--------|
| `/admin` (default) | `static-v2/admin.html` |
| `/admin-v1` | legacy light UI in `static/` |
| CSS / JS / icon | `/static-v2/*` |

## Static preview (no API)

```bash
python3 -m http.server 8765
# http://localhost:8765/static-v2/admin.html
```

API calls still use `/api/admin/*` on the same origin.

## Compatibility

Element **IDs**, `data-view` / `data-field`, and JS-facing **class names** match the original `static/admin.js` contract. Do not rename IDs or remove hooks used by runtime-generated markup.
