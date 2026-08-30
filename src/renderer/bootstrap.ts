/**
 * Starting the sidecar, and the handshake that follows.
 *
 * Under Electron the backend was the Main process and started itself. Under
 * Vantail the webview is the only thing running, so it spawns the backend and
 * then has to be told where it landed.
 *
 * Two secrets cross this boundary, both generated here:
 *
 * - The **master key** encrypts the sidecar's credential store. It is
 *   persisted in the OS keychain and nowhere else, so the encrypted store on
 *   disk is worthless to anyone who copies it off the machine.
 * - The **auth token** is per launch, never persisted, and demanded on every
 *   request. It is what stops any other local process from reading the user's
 *   provider credentials out of a loopback port.
 *
 * Neither is ever handed to interface code — `startSidecar` returns only a URL
 * and a token, and the token is useless once the process exits.
 */

import { filesystem, os, process as vantailProcess, secrets } from "@vantail/api";
import type { SidecarConnection } from "./api-client.ts";

/** How long to wait for the sidecar to announce its port before giving up. */
const READY_TIMEOUT_MS = 15_000;
const MASTER_KEY_SECRET = "store.masterKey";
const READY_PREFIX = "HIDEOUT_READY ";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64(bytes);
}

/**
 * The key the sidecar encrypts its store with, minted on first run and kept in
 * the OS keychain thereafter.
 */
async function loadOrCreateMasterKey(): Promise<string> {
  const existing = await secrets.get(MASTER_KEY_SECRET);
  if (existing) return existing;
  const created = randomBase64(32); // AES-256
  await secrets.set(MASTER_KEY_SECRET, created);
  return created;
}

/**
 * Where the sidecar lives, in the two forms we need it.
 *
 * `program` is matched *literally* against `permissions.shell.allow` — the
 * runtime does not expand `$RESOURCE` before comparing — so spawn has to be
 * handed the same string the config names. The filesystem API, by contrast,
 * takes a real path and checks it against the expanded scope. Hence both.
 */
async function sidecarBinary(): Promise<{ program: string; path: string }> {
  const suffix = (await os.platform()) === "windows" ? ".exe" : "";
  const relative = `bin/hideout-server${suffix}`;
  return {
    program: `$RESOURCE/${relative}`,
    path: `${await os.resourceDir()}/${relative}`,
  };
}

export async function startSidecar(): Promise<SidecarConnection> {
  const binary = await sidecarBinary();

  if (!(await filesystem.exists(binary.path))) {
    // Almost always a build that skipped the compile step rather than a
    // corrupt install, so say which command fixes it.
    throw new Error(`Sidecar binary missing at ${binary.path} — run \`npm run build:sidecar\``);
  }

  const token = randomBase64(32);
  const masterKey = await loadOrCreateMasterKey();

  // The data directory is deliberately not passed: the sidecar resolves it via
  // shared/paths.ts, which keeps the location the Electron build used. Handing
  // it Vantail's `appDataDir` — named after `app.identifier` — would point a
  // migrated install at an empty directory.
  const child = await vantailProcess.spawn(binary.program, [], {
    env: {
      HIDEOUT_AUTH_TOKEN: token,
      HIDEOUT_MASTER_KEY: masterKey,
    },
  });

  return new Promise<SidecarConnection>((resolve, reject) => {
    // stdout arrives as chunks, not lines, so the ready line can be split
    // across two of them. Buffer until a newline actually shows up.
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        void child.kill();
        reject(new Error(`Sidecar did not report a port within ${READY_TIMEOUT_MS}ms`));
      });
    }, READY_TIMEOUT_MS);

    child.onStdout((chunk) => {
      if (settled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith(READY_PREFIX)) return;

      try {
        const { port } = JSON.parse(line.slice(READY_PREFIX.length)) as { port: number };
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid port: ${String(port)}`);
        }
        finish(() => resolve({ baseUrl: `http://127.0.0.1:${port}`, token }));
      } catch (err) {
        finish(() => {
          void child.kill();
          reject(new Error(`Unreadable sidecar handshake: ${(err as Error).message}`));
        });
      }
    });

    // The sidecar logs to stderr. Forward it so a backend failure is visible in
    // devtools rather than silently swallowed.
    child.onStderr((chunk) => console.error(`[sidecar] ${chunk.trimEnd()}`));

    child.onExit(({ code }) => {
      finish(() => reject(new Error(`Sidecar exited with code ${String(code)} before it was ready`)));
    });
  });
}
