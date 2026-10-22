# PisoWiFi Monitoring - Design System export

Approved design: Emerald Teal + Charcoal, app name "PisoWiFi Monitoring". Design files only; no backend.

## What is inside
- `project/` - the Design System exactly as published (folder structure kept):
  - `README.md` - rules: content, honesty, colour, layout, screens, bundle usage
  - `tokens.json` - all colour (light/dark), type, spacing, radius, shadow tokens
  - `design-system.json` - the Design System's own index/manifest
  - `components/` - 20 component files: `bundle.css`, `bundle.js`, 3 component READMEs and 15 `preview.html` screens
  - `components/index.d.ts` - TypeScript types for the bundle helpers (local source file; it was never part of the online page because that host cannot serve .d.ts)
- `styles/tokens.css` - tokens.json turned into CSS variables (load before bundle.css)
- `styles/fonts.css` - Google Fonts import for Inter and JetBrains Mono
- `reference/pisowifi-monitoring-prototype.html` - the approved interactive prototype (single file, open in a browser)
- `manifest.json` - every file with size and SHA-256 so you can check nothing changed

## Using it in VS Code
1. Unzip into your project, for example `design/`.
2. Open `reference/pisowifi-monitoring-prototype.html` in a browser as the visual reference.
3. Point Claude Code at `design/pisowifi-monitoring-design-system/project/README.md` and `tokens.json` first.

The previews use `window.PisoWiFi` from `bundle.js` and expect tokens.css + bundle.css on the page.
