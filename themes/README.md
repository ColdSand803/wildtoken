# WildToken Theme Packs

Put CSS-only admin themes in this directory. Docker Compose mounts this folder
into the container at `/app/themes`.

Bundled theme packs follow the same format as third-party packs. The default
dark and light themes stay in `static/css`; every other shipped theme lives in
this directory.

Each theme pack is one child directory:

```text
themes/
  soul-society/
    theme.json
    theme.css
```

`theme.json`:

```json
{
  "id": "soul-society",
  "label": "Soul Society",
  "css": "theme.css",
  "swatch": ["#111827", "#f97316"],
  "version": "1.0.0",
  "description": "Optional short note"
}
```

The `id` must match the directory name and use lowercase letters, numbers, and
hyphens. The `css` path must be a relative `.css` file inside the same theme
directory. Theme CSS should scope rules under `html[data-theme="<id>"]`.
