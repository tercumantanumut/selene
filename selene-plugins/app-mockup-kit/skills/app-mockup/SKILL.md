---
name: "app-mockup"
description: "Create deterministic browser, tablet, laptop, and phone mockups from real screenshots via the local TypeScript renderer in this plugin. Use for marketing visuals, store screenshots, and framed UI previews without ML image generation."
allowed-tools: "executeCommand, readFile, writeFile, chromiumWorkspace"
---

# App Mockup

Use this skill when a user wants an existing screenshot wrapped in a browser or device frame.

## Do use it for

- browser-framed web app screenshots
- phone, tablet, or laptop mockups for real app screens
- deterministic export workflows from terminal commands
- marketing or documentation visuals generated from existing UI screenshots

## Do not use it for

- imaginary UI generation from text only
- lifestyle scenes or product photography
- diffusion/ML image editing
- claiming photoreal exports when only vector framing is requested

## Renderer contract

Run the local renderer in this plugin:

```bash
npm --prefix selene-plugins/app-mockup-kit run render -- \
  --input <path-or-image-url> \
  --output <output.svg> \
  --preset <preset>
```

## Supported presets

- `browser-chrome`
- `browser-safari`
- `iphone-14-pro`
- `pixel-6-pro`
- `ipad-pro`
- `macbook-pro`
- `window`
- `plain`

## Workflow

1. Identify the screenshot source.
   - If the user gives a file path, use it directly.
   - If the user gives a webpage URL, capture a screenshot first with browser tooling, then render the mockup.
   - If the user gives an image URL that already points to a screenshot, pass it directly to the renderer.

2. Infer the right preset.
   - web app or dashboard -> `browser-chrome` unless Safari styling is explicitly requested
   - iOS mobile app -> `iphone-14-pro`
   - Android mobile app -> `pixel-6-pro`
   - tablet layout -> `ipad-pro`
   - laptop hero shot -> `macbook-pro`

3. Render with explicit options.
   - Prefer SVG output unless the user explicitly requires a raster export pipeline.
   - Use descriptive output names.
   - Add title, subtitle, URL label, background, padding, and shadow only when they improve the requested result.

4. Verify the artifact.
   - Confirm the output file exists.
   - Report the output path, preset, and notable options used.

## Example commands

```bash
npm --prefix selene-plugins/app-mockup-kit run render -- \
  --input ./tmp/pricing-page.png \
  --output ./out/pricing-browser-mockup.svg \
  --preset browser-chrome \
  --url selene.so/pricing \
  --background gradient:#0f172a,#2563eb \
  --padding 80 \
  --shadow lifted
```

```bash
npm --prefix selene-plugins/app-mockup-kit run render -- \
  --input ./tmp/mobile-home.png \
  --output ./out/mobile-hero.svg \
  --preset iphone-14-pro \
  --title "Inbox, rethought" \
  --subtitle "Zero-noise triage for support teams"
```

## Notes for agents

- This plugin is standalone and should work in any host that understands Claude-style plugin folders or reusable skills.
- Screenshot capture is separate from mockup rendering.
- The included reference notes explain how this package borrows the deterministic framing idea from Screenshot.rocks while exposing a terminal-first interface for agents.
