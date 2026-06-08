# Acknowledgments & Thanks

Selene is built on the shoulders of giants. We are grateful to the open-source projects and libraries that make this application possible.

## AI Foundation

- **[Vercel AI SDK](https://sdk.vercel.ai/)** and its provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`). The core of all AI interactions in Selene.
- **[Assistant UI](https://assistant-ui.com/)** (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`, `@assistant-ui/react-markdown`). Chat interface components.
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**. Local OAuth-bearing proxy that exposes Claude Code (and other CLI-bound providers) as standard Anthropic/OpenAI endpoints. Powers the Claude Code provider.
- **[Model Context Protocol SDK](https://modelcontextprotocol.io/)** (`@modelcontextprotocol/sdk`). Tool and data integration standard.
- **[GPT Tokenizer](https://github.com/niieani/gpt-tokenizer)**. Token counting across models.
- **[Zod](https://zod.dev/)**. Schema validation for tool parameters and settings.

## Voice & Avatar

- **[TalkingHead.js](https://github.com/nicokruk/TalkingHead)** (`@met4citizen/talkinghead`). The 3D avatar engine with lip sync and facial expressions.
- **[Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync)**. Phoneme-level lip sync analysis.
- **[FFT.js](https://github.com/nicedoc/fft.js)**. Audio processing for amplitude-based lip sync.
- **[Whisper.cpp](https://github.com/ggerganov/whisper.cpp)**. Local speech-to-text.
- **[Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx)** (Parakeet). Local 32-language speech-to-text.
- **[Edge TTS](https://github.com/nicedoc/node-edge-tts)** (`node-edge-tts`). Free text-to-speech provider.
- **[FFmpeg](https://ffmpeg.org/)** (`ffmpeg-static`). Audio and video format conversion.

## Local AI & Inference

- **[Ollama](https://ollama.com/)**. Local LLM execution.
- **[Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js)** (`@huggingface/transformers`). Local embedding models.
- **[ONNX Runtime](https://onnxruntime.ai/)** (`onnxruntime-node`, `onnxruntime-web`). Local inference engine.
- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI)**. Local image generation backend.

## Channels & Integrations

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** (`@whiskeysockets/baileys`). WhatsApp integration.
- **[Grammy](https://grammy.dev/)**. Telegram bot framework.
- **[Slack Bolt](https://slack.dev/bolt-js/)** (`@slack/bolt`). Slack app integration.
- **[Discord.js](https://discord.js.org/)**. Discord bot integration.

## Data & Search

- **[LanceDB](https://lancedb.com/)** (`@lancedb/lancedb`). Embedded vector database for semantic search.
- **[Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)**. Application database.
- **[Drizzle ORM](https://orm.drizzle.team/)** (`drizzle-orm`, `drizzle-kit`). Type-safe database layer.
- **[Ripgrep](https://github.com/BurntSushi/ripgrep)** (`@vscode/ripgrep`). Fast pattern search across codebases.

## Developer Tools

- **[simple-git](https://github.com/steveukx/git-js)**. Git operations for workspaces, branches, and PRs.
- **[Git Diff View](https://github.com/nicedoc/git-diff-view)** (`@git-diff-view/react`, `@git-diff-view/shiki`). Visual diff rendering.
- **[Playwright](https://playwright.dev/)** (`playwright-core`). Browser automation and testing.
- **[Puppeteer](https://pptr.dev/)**. Browser automation.
- **[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk)**. Token optimization for command outputs.
- **[Shiki](https://shiki.style/)** (`react-shiki`). Syntax highlighting.

## Web & Search Providers

- **[Tavily](https://tavily.com/)**. Web search API for deep research.
- **[DuckDuckGo](https://duckduckgo.com/)**. Free web search (vendored client).

## Desktop & Web Framework

- **[Next.js](https://nextjs.org/)** (v16). React framework.
- **[React](https://react.dev/)** (v19). UI library.
- **[Electron](https://www.electronjs.org/)** (v39). Desktop application shell.
- **[Tailwind CSS](https://tailwindcss.com/)**. Styling.
- **[Radix UI](https://www.radix-ui.com/)**. Accessible UI primitives.
- **[Framer Motion](https://www.framer.com/motion/)**. Animations.
- **[Anime.js](https://animejs.com/)**. Animations.
- **[Tiptap](https://tiptap.dev/)** (`@tiptap/react`, `@tiptap/starter-kit`). Rich text editor.
- **[Lucide Icons](https://lucide.dev/)** and **[Phosphor Icons](https://phosphoricons.com/)**. Iconography.
- **[next-intl](https://next-intl.dev/)**. Internationalization.
- **[Sonner](https://sonner.emilkowal.ski/)**. Toast notifications.
- **[Canvas Confetti](https://www.kirilv.com/canvas-confetti/)**. Celebration effects.

## Video & Creative

- **[Remotion](https://www.remotion.dev/)** (`remotion`, `@remotion/renderer`, `@remotion/bundler`). Programmatic video generation.
- **[Jimp](https://jimp-dev.github.io/jimp/)**. Image processing.
- **[QRCode](https://github.com/soldair/node-qrcode)**. QR code generation for channel pairing.

## Infrastructure

- **[Chokidar](https://github.com/paulmillr/chokidar)**. File system watching for folder sync.
- **[Cron](https://github.com/kelektiv/node-cron)**. Scheduled task execution.
- **[Pino](https://getpino.io/)** and **[Winston](https://github.com/winstonjs/winston)**. Logging.
- **[LRU Cache](https://github.com/isaacs/node-lru-cache)**. In-memory caching.
- **[Axios](https://axios-http.com/)**. HTTP client.
- **[Luxon](https://moment.github.io/luxon/)**. Date and timezone handling.

## Architectural Inspiration

- **[Context Engine AI](https://github.com/Context-Engine-AI/Context-Engine)** and **Augment Code Context Engine**. Inspiration for the context engine architecture.
- **OpenCode DCP (Dynamic Context Pruning)**. Inspiration for message compaction strategies.
- **[Anthropic Claude Code](https://docs.anthropic.com/en/docs/agents)**. Inspiration for the plugin and hooks system.

---

Thank you to all the contributors and maintainers of these projects. Your work is the foundation.
