# Hideout

Hideout is a local-first desktop application for connecting an AI client to local AI providers, Model Context Protocol (MCP) servers, and configurable assistants. It is built with [Vantail](https://github.com/Vantail/vantail) and TypeScript, uses Ollama as the included AI provider, and runs its Hono HTTP API in a separate local backend process.

## Architecture

The application is two processes:

```text
Vantail runtime (Rust, ~4 MB) — native window + platform webview
  └── webview: the interface, using @vantail/api
        │  spawns at startup, over the webview IPC bridge
        ↓
  Sidecar: a single Bun-compiled binary — Hono + AI/MCP/assistant registries
        └── spawns MCP stdio servers, reads and writes the data directory
```

The interface holds no provider credentials. It mints a master key on first run, keeps it in the OS keychain, and hands it to the sidecar at spawn time; every secret is encrypted and read on the sidecar side of that boundary. The sidecar listens on `127.0.0.1` on an OS-assigned port and requires a per-launch bearer token on every request, so no other process on the machine can reach it.

## Features

- **Vantail desktop app** using the platform webview (WKWebView, WebView2, WebKitGTK) with a strict content security policy and a build-time permission model in `vantail.config.ts`.
- **Ollama integration** for local chat, streaming chat, health checks, and model discovery.
- **MCP server management** for `stdio`, HTTP, and SSE transports, including add/edit/remove, enable/disable, health checks, real connection state, tool discovery, and tool execution.
- **Exa MCP preset** seeded automatically as an optional web-search tool configuration (`npx -y exa-mcp-server`).
- **Assistants** with reusable system instructions, model/provider preferences, and sampling parameters such as temperature, top-p, top-k, min-p, penalties, max tokens, stop sequences, and seed.
- **Local Hono API** for health checks and AI, MCP, and assistant operations, served by the sidecar.
- **Secure secret handling**: secrets are encrypted at rest with AES-256-GCM under a master key held in the OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux). They are redacted from API responses and logs, and never reach the interface.
- **Colored logging** with configurable log levels.
- **Loopback-first networking**: the sidecar binds `127.0.0.1`, and the built-in Ollama provider defaults to the local Ollama endpoint.

## Requirements

- **Node.js** with npm. Node.js 20 or newer is recommended.
- **Bun** is installed automatically as a devDependency and pinned to 1.4 or newer. It compiles the sidecar and runs the test suite. A much older global Bun will not work: Bun 1.0.x mis-handles Hono's JSON responses.
- A desktop environment with the platform webview available. No Chromium is bundled.
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

The application does not automatically load `.env` files. Export variables in the shell that launches the app:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run dev
```

Note that this only reaches the sidecar when the app is launched from a shell. A packaged app started from Finder or the Start menu does not inherit your shell environment; use the in-app configuration instead.

## Start the application

```bash
npm run dev
```

This compiles the sidecar, builds the web assets, and launches the Vantail runtime against the Vite dev server, with hot module replacement and devtools enabled.

To build and run a distributable bundle:

```bash
npm run package
```

The bundle is written to `build/<platform>/`. On macOS it is signed ad-hoc, which is enough to launch on the machine that built it; shipping to other people needs a Developer ID identity passed to `vantail package --sign`.

There is no port or hostname to configure. The sidecar takes an OS-assigned port on `127.0.0.1` and reports it to the interface, so two launches never collide and nothing else on the machine can guess where to find it.

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Compile the sidecar, build assets, and launch the app against the Vite dev server. |
| `npm run build` | Compile the sidecar and build the web assets into `dist/`. |
| `npm run build:sidecar` | Compile only the backend binary into `public/bin/`. |
| `npm run package` | Build and produce a native bundle in `build/`. |
| `npm run doctor` | Report the resolved Vantail toolchain, config, and runtime. |
| `npm run typecheck` | Run TypeScript checking without emitting build files. |
| `npm test` | Run the Bun test suite. |

The sidecar is compiled into `public/` rather than straight into `dist/` because `vantail build` and `vantail package` each run Vite themselves, which empties `dist/` first. Staging it in `public/` means every build path copies it in, with its executable bit intact.

## Project layout

```text
.
├── index.html          Interface entry document (Vite root)
├── vantail.config.ts   Window, app identity, and the runtime permission model
├── src/
│   ├── ai/             AI provider types, registry, Ollama provider, and secure storage
│   │   └── providers/  Concrete providers (Ollama)
│   ├── assistants/     Assistant configuration types, validation, registry, and disk persistence
│   ├── mcp/            MCP types, validation, registry, secure helpers, and the SDK-backed connection manager
│   ├── renderer/       Interface: bootstrap (spawns the sidecar), API client, and UI
│   ├── server/         The sidecar: entry point, Hono app, AI/MCP/assistant routes, PATH recovery
│   ├── shared/         API contracts and cross-platform path helpers
│   ├── index.ts        Small Hello World entry point used by the unit test
│   └── logger.ts       Configurable colored logger with redaction
├── public/bin/         Compiled sidecar binary (generated, git-ignored)
├── test/               Bun tests (Bun test runner)
├── package.json        Scripts and dependencies (type: module, Vantail, Hono 4)
├── tsconfig.json       Strict TypeScript configuration (ESNext, bundler resolution)
├── bunfig.toml         Bun test configuration
└── .env.example        Environment variable reference (loopback defaults)
```

## Local HTTP API

The sidecar's API is not a general-purpose local service. It listens on an OS-assigned port on `127.0.0.1` and rejects any request without the per-launch bearer token, which exists only in memory for the lifetime of the app. It is documented here because it is the contract the interface uses; reaching it from outside the app is not a supported workflow.

All responses are JSON unless noted; writes are rate-limited to 60 requests per minute per client.

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
- `GET /api/mcp/servers/:id/tools` — connects (if needed) and lists the server's exposed tools with their input schemas.
- `POST /api/mcp/servers/:id/call` — calls a tool on a connected server (`{ name, arguments? }`).
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

To exercise the API directly during development, run the sidecar yourself. It prints its port on stdout as `HIDEOUT_READY {"port":…}`:

```bash
HIDEOUT_AUTH_TOKEN=dev-token \
HIDEOUT_MASTER_KEY="$(head -c 32 /dev/urandom | base64)" \
./public/bin/hideout-server
```

```bash
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:<port>/api/ai/providers/ollama/models
```

Using a throwaway master key means the run will not decrypt secrets written under your real one.

## MCP setup

The app seeds an **Exa AI** `stdio` preset on first startup. It uses:

```text
command: npx
args: -y exa-mcp-server
```

This preset is displayed in the MCP section of the UI. Use **Check MCP** to connect to a server: it runs a real MCP handshake, lists the server's exposed tools, and lets you run each tool with JSON arguments from the UI. The health check probes the launcher; it does not require you to put secrets in the project.

You can add MCP servers from the UI using:

- **stdio** — a local executable such as `npx`, `uvx`, `node`, or `python3`, with arguments, environment variables, and an optional working directory.
- **http** — an HTTP MCP endpoint and optional timeout/headers.
- **sse** — an SSE-compatible endpoint using the same URL configuration shape.

Secret-looking environment values and header values are stored through the secure store rather than returned to the interface. Never commit API keys or other credentials to `.env`, source files, or JSON configuration.

Because a packaged desktop app does not inherit a shell environment, the sidecar recovers your login shell's `PATH` at startup (see `src/server/user-path.ts`). Without that, tools installed by a version manager — nvm in particular, whose directory contains the exact Node version — would not be found and every stdio server would fail with `ENOENT`.

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
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint. `AI_OLLAMA_BASE_URL` is also accepted. |
| `HIDEOUT_SECRET_AI_OLLAMA_APIKEY` | unset | Ephemeral dev API key for a proxied Ollama endpoint; prefer the secure store. |
| `HIDEOUT_SECRET_MCP_*` | unset | Ephemeral dev overrides for MCP secrets (`HIDEOUT_SECRET_MCP_<ID>_ENV_<VAR>` / `HEADER_<NAME>`); not persisted. |
| `HIDEOUT_MCP_STORE_DIR` | platform data directory | Override MCP storage dir for tests/portable use. Falls back to `HIDEOUT_SECURE_STORE_DIR` if set. |
| `HIDEOUT_SECURE_STORE_DIR` | platform data directory | Override secure-storage dir for tests/portable use. |
| `HIDEOUT_ASSISTANT_STORE_DIR` | platform data directory | Override assistant storage dir. Falls back to `HIDEOUT_MCP_STORE_DIR` / `HIDEOUT_SECURE_STORE_DIR`. |
| `LOG_LEVEL` | `INFO` (defaults to `DEBUG` when unset — see `src/logger.ts:58`) | `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT`. |
| `NO_COLOR` | unset | Set to any value to disable colored logs. `FORCE_COLOR=1` forces color. |

`HIDEOUT_AUTH_TOKEN` and `HIDEOUT_MASTER_KEY` are generated by the app and passed to the sidecar at spawn time. Set them by hand only when running the sidecar directly for development.

## Data and security

Runtime data is stored in the platform's application-data directory. These are the same locations the Electron build used, so an existing installation keeps its servers and assistants:

- macOS: `~/Library/Application Support/Hideout/`
- Windows: `%APPDATA%/Hideout/`
- Linux: `$XDG_CONFIG_HOME/hideout/` or `~/.config/hideout/`

Do not delete these files while the app is running. Removing them resets locally stored MCP and assistant configuration. Secure-store contents are encrypted with AES-256-GCM; the key is held in the OS keychain and never written next to the data it protects. A tampered store fails to decrypt rather than returning altered values.

The application is intended for local use. The sidecar is bound to loopback and token-authenticated; it is not designed to be exposed on a network.

### Upgrading from the Electron build

Servers, assistants, and other configuration carry over untouched. Stored **API keys do not**: they were encrypted with Electron's `safeStorage`, which cannot be decrypted without Electron. Re-enter them once from the UI and they will be re-encrypted under the new key.

## Development and verification

After changing TypeScript, run the checks before launching:

```bash
npm run typecheck
npm test
npm run build
```

The tests are run by Bun and currently cover the logger and the Hello World entry point. Build output is written to `dist/` and `build/`, both ignored by Git.

## Troubleshooting

### The app window is blank, or reports that the backend did not start

The interface reports sidecar failures at the top of the window. Check that the binary exists:

```bash
npm run build:sidecar
```

Sidecar logs are forwarded to the webview console, which `npm run dev` opens by default.

### Ollama is unhealthy

Verify Ollama is running and that the configured URL responds:

```bash
curl http://127.0.0.1:11434/api/tags
```

If needed, pull a model with `ollama pull llama3.2` or set `OLLAMA_BASE_URL` to the correct loopback endpoint.

### Exa or another stdio MCP server reports "Command not found"

Confirm the launcher exists in your own shell:

```bash
npx --version
```

The sidecar resolves your login shell's `PATH` at startup, so a tool available in your terminal should be available to a packaged app too. If it is not, check that the command is on the `PATH` your login shell sets, rather than one exported by a single terminal session.

Hideout launches stdio commands without a shell, so shell-specific command strings and shell operators are not supported.

### macOS asks for your keychain password on every build

An ad-hoc signature changes on each build, and the keychain binds access to the signing identity. Packaging with a stable Developer ID identity makes it a one-time approval.

### Logs are too noisy or have unwanted colors

Use the logger environment variables:

```bash
LOG_LEVEL=WARN NO_COLOR=1 npm run dev
```

## License

No license file is currently included in the repository. Treat the project as private unless the project owner provides licensing terms.
