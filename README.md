# Hideout

Hideout is a local-first desktop application for connecting an AI client to local AI providers, Model Context Protocol (MCP) servers, and configurable assistants. It is built with Electron and TypeScript, uses Ollama as the included AI provider, and embeds a localhost-only Hono HTTP API.

## Features

- **Electron desktop app** with a sandboxed renderer, context isolation, disabled Node integration, strict content security policy, and blocked untrusted navigation.
- **Ollama integration** for local chat, streaming chat, health checks, and model discovery.
- **MCP server management** for `stdio`, HTTP, and SSE transports, including add/edit/remove, enable/disable, health checks, connection state, and tool listing.
- **Exa MCP preset** seeded automatically as an optional web-search tool configuration (`npx -y exa-mcp-server`).
- **Assistants** with reusable system instructions, model/provider preferences, and sampling parameters such as temperature, top-p, top-k, min-p, penalties, max tokens, stop sequences, and seed.
- **Local Hono API** for health checks and AI, MCP, and assistant operations.
- **Secure secret handling**: secrets are kept in the Electron main process and stored using Electron `safeStorage` when available. Secrets are redacted from renderer/API responses and logs.
- **Colored logging** with configurable log levels.
- **Loopback-first networking**: the Hono server defaults to `127.0.0.1`, and the built-in Ollama provider defaults to the local Ollama endpoint.

## Requirements

- **Node.js** with npm. Node.js 20 or newer is recommended.
- **Bun** for the test suite (`bun test`). Install Bun from <https://bun.sh> if it is not already installed.
- A desktop environment supported by Electron.
- **Ollama** is optional for launching the UI, but required to use the included AI provider. Install it from <https://ollama.com>.
- **npx** is required if you want to use the seeded Exa MCP server or another npm-based `stdio` MCP server.

## Installation

Clone the repository and enter the project directory:

```bash
git clone <repository-url>
cd hideout
```

Install the dependencies declared in `package.json`:

```bash
npm install
```

The repository includes `bun.lock` for Bun-based dependency workflows. If you use Bun instead, install dependencies with:

```bash
bun install
```

## Configure Ollama

Start Ollama using its normal desktop application or CLI, then download at least one model:

```bash
ollama serve
ollama pull llama3.2
```

Hideout uses `http://127.0.0.1:11434` by default and selects `llama3.2` as the default model. The app can still start if Ollama is unavailable; the UI will report the provider as unhealthy until Ollama is running.

To use a different loopback endpoint, copy the example environment file and edit it:

```bash
cp .env.example .env
```

Then set, for example:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The application does not automatically load `.env` files. Export variables in the shell that launches Electron, or use your shell’s environment-file support. For example:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm start
```

## Start the application

Build the TypeScript sources and launch Electron:

```bash
npm start
```

`npm start` runs the build first, copies the renderer HTML into `dist`, generates the CommonJS sandbox preload, and then starts Electron.

The equivalent development command is:

```bash
npm run dev
```

At runtime, the app starts the Hono server when the window is ready. It listens on `127.0.0.1:3000` by default. To select another local port:

```bash
HONO_PORT=3001 npm start
```

To explicitly choose the bind address, set `HONO_HOSTNAME`; keeping it at `127.0.0.1` is recommended:

```bash
HONO_HOSTNAME=127.0.0.1 HONO_PORT=3001 npm start
```

To open Chromium DevTools while developing:

```bash
ELECTRON_OPEN_DEVTOOLS=1 NODE_ENV=development npm start
```

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Build the project and launch the Electron application. |
| `npm run dev` | Build and launch Electron; currently equivalent to `npm start`. |
| `npm run build` | Typecheck/compile TypeScript, copy the renderer HTML, and generate the sandbox preload bundle. |
| `npm run typecheck` | Run TypeScript checking without emitting build files. |
| `npm run dev:watch` | Run TypeScript in watch mode (recompile on change; relaunch Electron manually). |
| `npm test` | Run the Bun test suite. |

## Project layout

```text
.
├── src/
│   ├── ai/             AI provider types, registry, Ollama provider, and secure storage
│   │   └── providers/  Concrete providers (Ollama)
│   ├── assistants/     Assistant configuration types, validation, registry, and disk persistence
│   ├── main/           Electron main-process lifecycle, window creation, and IPC handlers
│   ├── mcp/            MCP types, validation, registry, secure helpers, and connection manager
│   ├── preload/        Context-bridge API exposed to the renderer (sandbox-safe, CJS-built)
│   ├── renderer/       Desktop UI HTML and renderer TypeScript (AI / MCP / Assistant cards + dialogs)
│   ├── server/         Hono app, AI/MCP/Assistant routes, and localhost server lifecycle
│   ├── shared/         IPC channels, API contracts, and cross-platform path helpers
│   ├── index.ts        Small Hello World entry point used by the unit test
│   └── logger.ts       Configurable colored logger with redaction
├── scripts/
│   └── build-preload-cjs.mjs  Converts the compiled ESM preload to sandbox-compatible CommonJS
├── test/               Bun tests (Bun test runner)
├── package.json        Scripts and dependencies (type: module, Electron 44, Hono 4)
├── tsconfig.json       Strict TypeScript configuration (ESNext, bundler resolution)
├── bunfig.toml         Bun test configuration
└── .env.example        Environment variable reference (loopback defaults)
```

## Local HTTP API

The embedded Hono server is local-only by default. Once the app is running, these endpoints are available at `http://127.0.0.1:3000` (all JSON unless noted; writes are rate-limited to 60 req/min per IP):

- `GET /` — returns `Hello World` as plain text.
- `GET /health` — returns a JSON health response.
- `GET /api/hello` — returns the Hello World message as JSON.
- `GET /api/ai/providers` — lists configured AI providers (safe config, no secrets).
- `GET /api/ai/providers/:id/health` — checks an AI provider.
- `GET /api/ai/providers/:id/models` — lists provider models.
- `POST /api/ai/chat` — sends a non-streaming chat request (supports `assistantId` adherence).
- `POST /api/ai/chat/stream` — sends a streaming chat request using server-sent events (`event: delta` / `done` / `error`).
- `GET /api/mcp/servers` — lists MCP servers with secrets redacted (`"***"`).
- `GET /api/mcp/servers/:id` — gets one MCP server (safe).
- `POST /api/mcp/servers` — creates an MCP server.
- `PUT /api/mcp/servers/:id` — creates or replaces an MCP server.
- `PATCH /api/mcp/servers/:id` — partially updates an MCP server.
- `DELETE /api/mcp/servers/:id` — removes an MCP server.
- `POST /api/mcp/servers/:id/enable` — enables a server.
- `POST /api/mcp/servers/:id/disable` — disables a server (also disconnects).
- `POST /api/mcp/servers/:id/enabled` — toggles enabled state (`{ enabled: boolean }`).
- `GET /api/mcp/servers/:id/health` — checks an MCP server.
- `POST /api/mcp/servers/:id/connect` — connects/checks an MCP server.
- `POST /api/mcp/servers/:id/disconnect` — disconnects an MCP server.
- `GET /api/mcp/servers/:id/tools` — lists known tools.
- `GET /api/mcp/presets/exa` — returns the seeded Exa preset (safe + raw).
- `GET /api/assistants` — lists assistants.
- `GET /api/assistants/:id` — gets one assistant.
- `POST /api/assistants` — creates an assistant.
- `PUT /api/assistants/:id` — creates or replaces an assistant.
- `PATCH /api/assistants/:id` — partially updates an assistant.
- `DELETE /api/assistants/:id` — removes an assistant.
- `POST /api/assistants/:id/enable` — enables an assistant.
- `POST /api/assistants/:id/disable` — disables an assistant.
- `POST /api/assistants/:id/enabled` — toggles enabled state (`{ enabled: boolean }`).

For complete request and response shapes, see the route files in `src/server/` and the shared contracts in `src/shared/api.ts`.

Example health check:

```bash
curl http://127.0.0.1:3000/health
```

Example Ollama model check:

```bash
curl http://127.0.0.1:3000/api/ai/providers/ollama/models
```

## MCP setup

The app seeds an **Exa AI** `stdio` preset on first startup. It uses:

```text
command: npx
args: -y exa-mcp-server
```

This preset is displayed in the MCP section of the UI. Use **Check MCP** to verify that `npx` is available. The health check probes the launcher; it does not require you to put secrets in the project.

You can add MCP servers from the UI using:

- **stdio** — a local executable such as `npx`, `uvx`, `node`, or `python3`, with arguments, environment variables, and an optional working directory.
- **http** — an HTTP MCP endpoint and optional timeout/headers.
- **sse** — an SSE-compatible endpoint using the same URL configuration shape.

Secret-looking environment values and header values are stored through the secure store rather than returned to the renderer. Never commit API keys or other credentials to `.env`, source files, or JSON configuration.

## Assistant setup

Assistants are managed from the **Assistants** section of the UI. Each assistant can define:

- A unique ID, display name, description, and optional emoji.
- System instructions injected before the conversation.
- An optional provider ID and model preference.
- Sampling and generation parameters.
- An enabled/disabled state.

When an assistant is selected for chat, its instructions and defaults are applied, while explicitly supplied chat options take precedence.

## Configuration reference

Copy `.env.example` to review the available settings. The main options are:

| Variable | Default | Description |
| --- | --- | --- |
| `HONO_PORT` | `3000` | Local Hono server port. `PORT` is accepted as a fallback. |
| `HONO_HOSTNAME` | `127.0.0.1` | Hono bind hostname (keep at loopback). |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint. `AI_OLLAMA_BASE_URL` is also accepted. |
| `HIDEOUT_SECRET_AI_OLLAMA_APIKEY` | unset | Ephemeral dev API key for a proxied Ollama endpoint; prefer the OS keychain/secure store. |
| `HIDEOUT_SECRET_MCP_*` | unset | Ephemeral dev overrides for MCP secrets (`HIDEOUT_SECRET_MCP_<ID>_ENV_<VAR>` / `HEADER_<NAME>`); not persisted. |
| `HIDEOUT_MCP_STORE_DIR` | platform data directory | Override MCP storage dir for tests/portable use. Falls back to `HIDEOUT_SECURE_STORE_DIR` if set. |
| `HIDEOUT_SECURE_STORE_DIR` | platform data directory | Override secure-storage dir for tests/portable use. |
| `HIDEOUT_ASSISTANT_STORE_DIR` | platform data directory | Override assistant storage dir. Falls back to `HIDEOUT_MCP_STORE_DIR` / `HIDEOUT_SECURE_STORE_DIR`. |
| `LOG_LEVEL` | `INFO` (defaults to `DEBUG` when unset — see `src/logger.ts:58`) | `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT`. |
| `NO_COLOR` | unset | Set to any value to disable colored logs. `FORCE_COLOR=1` forces color. |
| `ELECTRON_OPEN_DEVTOOLS` | unset | Set to `1` (with `NODE_ENV != production`) to open Chromium DevTools. |

## Data and security

Runtime data is stored in the platform’s application-data directory. Electron uses its `userData` path for the desktop app; outside Electron, platform-specific Hideout directories are used. Assistant and MCP configuration files are protected with restrictive permissions where supported.

- macOS: `~/Library/Application Support/Hideout/`
- Windows: `%APPDATA%/Hideout/`
- Linux: `$XDG_CONFIG_HOME/hideout/` or `~/.config/hideout/`

Do not delete these files while the app is running. Removing them resets locally stored MCP and assistant configuration. Secure-store contents may be encrypted using Electron’s OS-backed `safeStorage` facility.

The application is intended for local use. Keep Hono bound to loopback unless you have a specific, controlled networking requirement and understand the security implications.

## Development and verification

After changing TypeScript, run the checks before launching:

```bash
npm run typecheck
npm test
npm run build
```

The tests are run by Bun and currently cover the logger and the Hello World entry point. The build output is written to `dist/`, which is ignored by Git.

## Troubleshooting

### Electron does not start

Run the build separately and inspect its output:

```bash
npm run build
```

Make sure dependencies are installed and that you are running the command from the project root.

### Ollama is unhealthy

Verify Ollama is running and that the configured URL responds:

```bash
curl http://127.0.0.1:11434/api/tags
```

If needed, pull a model with `ollama pull llama3.2` or set `OLLAMA_BASE_URL` to the correct loopback endpoint.

### Port 3000 is already in use

Start Hideout on another port:

```bash
HONO_PORT=3001 npm start
```

### Exa or another stdio MCP server cannot be checked

Confirm the launcher exists:

```bash
npx --version
```

For other servers, verify the configured command, arguments, and working directory. Hideout launches stdio commands without a shell, so shell-specific command strings and shell operators are not supported.

### Logs are too noisy or have unwanted colors

Use the logger environment variables:

```bash
LOG_LEVEL=WARN NO_COLOR=1 npm start
```

## License

No license file is currently included in the repository. Treat the project as private unless the project owner provides licensing terms.
