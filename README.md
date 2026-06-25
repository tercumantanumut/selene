# Selene

<div align="center">

![Version](https://img.shields.io/badge/version-0.3.4-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

<div align="center">
  <img src="assets/demo.gif" alt="Selene Demo" width="800"/>
</div>

<br/>

Selene is an agent-first desktop app that runs AI on your machine. Chat, write code, generate images, design UIs, control a browser — then pipe all of it into WhatsApp, Telegram, Slack, or Discord. Your data stays on your device. Every part of Selene — chat, embeddings, voice, images — lets you pick between local and cloud. Run fully offline or bring your own API keys. Mix and match.

<p align="center">
  <a href="#providers"><img src="public/icons/brands/anthropic.svg" alt="Anthropic" height="18"></a> <a href="#providers"><img src="public/icons/brands/openai.svg" alt="OpenAI" height="18"></a> <a href="#providers"><img src="public/icons/brands/ollama.svg" alt="Ollama" height="18"></a> <a href="#providers"><img src="public/icons/brands/openrouter.svg" alt="OpenRouter" height="18"></a> <a href="#providers"><img src="public/icons/brands/google.svg" alt="Google" height="18"></a> <a href="#providers"><img src="public/icons/brands/minimax.svg" alt="Minimax" height="18"></a> <a href="#providers"><img src="public/icons/brands/kimi.svg" alt="Kimi" height="18"></a> <a href="#providers"><img src="public/icons/brands/moonshot.png" alt="Moonshot" height="18"></a> <a href="#channels"><img src="public/icons/brands/slack.svg" alt="Slack" height="18"></a> <a href="#channels"><img src="public/icons/brands/telegram.svg" alt="Telegram" height="18"></a> <a href="#channels"><img src="public/icons/brands/discord.svg" alt="Discord" height="18"></a> <a href="#channels"><img src="public/icons/brands/whatsapp.svg" alt="WhatsApp" height="18"></a> <a href="#voice--avatar"><img src="public/icons/brands/elevenlabs.svg" alt="ElevenLabs" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/comfyui.svg" alt="ComfyUI" height="18"></a> <a href="#modes"><img src="public/icons/brands/chromium.svg" alt="Chromium" height="18"></a> <a href="#extend-it"><img src="public/icons/brands/mcp.svg" alt="MCP" height="18"></a> <a href="#modes"><img src="public/icons/brands/puppeteer.svg" alt="Playwright" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/duckduckgo.svg" alt="DuckDuckGo" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/firecrawl.svg" alt="Firecrawl" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/lancedb.png" alt="LanceDB" height="18"></a> <a href="#voice--avatar"><img src="public/icons/brands/microsoft.svg" alt="Microsoft" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/remotion.svg" alt="Remotion" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/tavily.svg" alt="Tavily" height="18"></a> <a href="#creative-tools"><img src="public/icons/brands/onnx.svg" alt="ONNX Runtime" height="18"></a> <a href="#for-developers"><img src="public/icons/brands/github.svg" alt="GitHub" height="18"></a>
</p>

<br/>

## Agent-First, Not Button-First

Every UI action is also an agent action — step in anywhere or let it run end-to-end.

## Why We Built It

AI is expensive because models re-read everything, every turn. Selene runs a small retrieval pipeline first — it finds what's relevant, the main agent picks it up and moves on. Tools load on demand. Context stays lean. You pay less per turn.

## What's New in v0.3.4

- **Voice input, rewritten.** Your words land in the composer the instant recording stops; grammar polishing happens in the background. Start a new recording while a previous one is still polishing — they no longer block each other.
- **Design Workspace.** Generate UI components with AI, preview them live in an isolated sandbox, edit-in-place via patches.
- **[Ghost OS](https://github.com/ghostwright/ghost-os).** Agents can see your screen through a vision sidecar, wired into the MCP tool pipeline.
- **Folder Sync.** Replaces the old Knowledge Base. Native FSEvents on macOS, toast notifications, and a proper progress bar.
- **Claude Opus 4.7 + Kimi OAuth.** New flagship Anthropic model (1M context, thinking) and device-flow sign-in for Kimi — no more API-key copy-paste.
- **Platform bump.** Electron 41 / Chrome 146 / Node 24, 9 Dependabot advisories closed, hundreds of unused files pruned.

Full notes: [`RELEASE_NOTES_v0.3.4.md`](./RELEASE_NOTES_v0.3.4.md) · [All releases on GitHub](https://github.com/tercumantanumut/selene/releases)

## Modes

### Selene Dev
- **Git, diffs, and PRs.** Stage, branch, diff, PR — from the UI or via agent.
- **Built-in browser.** Agent-controlled Chromium with console log access and session replay.
- **Output protection.** Bundled Rust tool trims long build/test output before it hits the model.
- **Automatic checks.** Hooks run type-checking, linting, or any custom logic after agent edits.

### Selene Fun
- **3D avatar.** Animated face with lip-sync and emotion detection.
- **Voice cloning.** Custom voice via ElevenLabs or Microsoft.
- **Scheduled assistants.** Cron tasks delivered to any connected channel.
- **Memory.** Selene surfaces things to remember; you approve what sticks.

### Design Workspace
- **AI components, live.** Generate React/HTML components; they render immediately in an isolated sandbox.
- **Edit-in-place.** Ask for tweaks and the agent applies targeted patches instead of regenerating from scratch.
- **Responsive previews.** Mobile / tablet / desktop viewport toggles, plus Light / Dark / System.

### Chromium Workspace
- **Real browser, agent-driven.** Embedded Chromium controlled through Playwright — navigate, click, type, extract, evaluate JS.
- **Parallel isolation.** Each agent gets its own BrowserContext; sub-agents can drive separate tabs concurrently without stepping on each other.
- **Accessibility-tree observation.** Token-efficient snapshots instead of screenshots — deterministic, cheap, no vision model needed.
- **Full action replay.** Every session is recorded with inputs, outputs, and DOM snapshots; replay with retry and output verification.

### [Ghost OS](https://github.com/ghostwright/ghost-os)
- **Screen awareness.** Agents see what's on your display through a vision sidecar.
- **MCP-native.** `ghost_parse_screen` and `ghost_annotate` are exposed as tools the main agent can pick up.
- **Pre-flight health checks.** Sidecar auto-boots before the first call; status visible in MCP settings.

## Channels

Connect your agent to your apps. Not through webhooks — as native integrations.

| Channel | Setup | What works |
|---------|-------|------------|
| **WhatsApp** | Scan a QR code | Messages, voice notes, attachments |
| **Telegram** | Paste a bot token | Messages, voice bubbles, interactive buttons |
| **Slack** | Socket Mode | Messages, files, native UI elements, threads |
| **Discord** | Paste a bot token | Messages, threads, buttons, attachments |

Voice notes are transcribed automatically. Pair with the scheduler for cron-based delivery.

## Features

| | |
|---|---|
| **Voice Input** | Instant transcription, background grammar polish, concurrent recordings, per-recording cursor memory, dedicated transcriber model |
| **Voice & Avatar** | STT (cloud/local, 32 languages), TTS with voice cloning, 3D avatar with lip-sync |
| **Images** | Local or cloud generation, reference images, ComfyUI workflows as agent tools |
| **Video** | Images → MP4 with transitions and overlays |
| **Design Workspace** | Generate UI components with AI, live sandbox preview, edit-in-place via patches |
| **Chromium Workspace** | Agent-driven embedded browser (Playwright), parallel session isolation, accessibility-tree snapshots, full action replay |
| **[Ghost OS](https://github.com/ghostwright/ghost-os)** | Agents can see your screen via a vision sidecar |
| **Folder Sync** | Sync folders directly to agents; native FSEvents on macOS; replaces the old Knowledge Base |
| **Deep Research** | Multi-pass web search with cited writeups |
| **Memory** | Surfaces suggestions after conversations; you approve what sticks |
| **Scheduler** | Cron, interval, or one-time tasks — delivered to any channel or kept in chat |
| **Skills** | Reusable agent instructions. 37+ built-in, create your own from the UI |
| **Plugins** | Bundle skills and tools together. Install from GitHub or a URL |
| **Workflows** | Multi-agent delegation with parallel sub-agents and auto-delivered results |
| **MCP** | Connect external services as agent tools |
| **Hooks** | Run custom logic before or after any agent action |
| **Workspace Styles** | Classic Sidebar or Browser Tabs layout |
| **Themes** | 8 color themes, light/dark, 50 wallpapers (20 live), rich text prompt editor |

## Providers

Use any combination, or go fully local with no API keys.

| Provider | Models |
|----------|--------|
| **Anthropic** | Claude (Opus 4.7, Sonnet, Haiku) via API or Agent SDK |
| **OpenAI** | GPT-5 family + Codex |
| **OpenRouter** | Claude, Gemini, Grok, DeepSeek, and hundreds more |
| **Ollama** | Any local model; dynamic thinking detection |
| **vLLM** | Self-hosted inference |
| **Kimi / Moonshot** | K2.5, K2.6, K2.7 Code; OAuth device-flow sign-in |
| **Minimax** | Multiple variants |
| **Antigravity** | Free tier via Google OAuth |

## Download

**macOS.** Signed DMG, drag to Applications.
**Windows.** Signed installer or portable build.

One download, no prerequisites. Selene bundles everything: Electron 41 (Chrome 146 / Node 24), local model support, browser engine, platform tools. The app is larger than usual because it ships what other tools make you install separately.

Grab the latest build on the [Releases page](https://github.com/tercumantanumut/selene/releases).

## For Developers

### Setup
```bash
npm install
npm run electron:dev
```

### Build
```bash
# Windows
npm run electron:dist:win:nosign

# macOS
npm run electron:dist:mac:nosign
```

### Troubleshooting
- **Native module errors**: `npm run electron:rebuild-native` (rebuilds against the bundled Electron ABI)
- **Embeddings mismatch**: reindex from Settings
- **MCP ENOENT**: reinstall from latest DMG/installer

## Thanks

Built on open-source. See [THANKS.md](./THANKS.md).
