/**
 * Recovering the user's real PATH.
 *
 * A desktop app launched from Finder inherits launchd's environment, not a
 * shell's. On a machine where `launchctl getenv PATH` is unset — the default —
 * that means `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every MCP stdio
 * server then fails with ENOENT, because `npx`, `uvx`, `node` and friends live
 * in directories only a shell rc file ever adds.
 *
 * A hardcoded list of the usual suspects is not enough. Version managers are
 * the common case and the ones a static list cannot cover: nvm installs to
 * `~/.nvm/versions/node/<exact version>/bin`, which changes when the user
 * switches versions. The only reliable source of the PATH the user actually
 * has is the shell they actually use.
 *
 * So: ask it. Run the login shell the way a terminal would, and read back its
 * PATH. This runs the user's own rc files — the same ones that run whenever
 * they open a terminal — and its blast radius is smaller than what the feature
 * it enables already does, which is `npx -y <arbitrary package>`.
 */

import { execFile } from "node:child_process";
import { homedir, platform, userInfo } from "node:os";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "user-path" });

/** Delimits PATH in the shell's output, so an rc file's banner cannot be mistaken for it. */
const MARKER = "__HIDEOUT_PATH__";

/** An rc file can hang (a prompt, a `read`); do not let that hang startup. */
const SHELL_TIMEOUT_MS = 5000;

/**
 * Directories worth having even when the shell cannot be asked. Deliberately
 * a fallback rather than the primary mechanism — it cannot cover nvm and the
 * other version managers, which is exactly the case that breaks.
 */
function fallbackDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.deno/bin`,
  ];
}

function askLoginShell(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    // -i and -l together: `-l` sources the profile, `-i` sources the
    // interactive rc where nvm and friends are usually set up. Either alone
    // misses one of the two common layouts.
    const script = `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`;
    execFile(
      shell,
      ["-ilc", script],
      { timeout: SHELL_TIMEOUT_MS, encoding: "utf-8" },
      (err, stdout) => {
        if (err && !stdout) {
          logger.warn(`Could not read PATH from ${shell}: ${err.message}`);
          resolve(null);
          return;
        }
        const match = stdout.split(MARKER)[1];
        resolve(match && match.length > 0 ? match : null);
      },
    );
  });
}

/**
 * The user's shell as the OS records it, independent of any environment.
 *
 * The value is checked for an absolute path because it is not always one:
 * under a stripped environment this comes back as the literal "unknown", and
 * handing that to execFile produces a confusing "not found" for a shell the
 * user does have.
 */
function loginShellFromPasswd(): string | null {
  try {
    const shell = userInfo().shell;
    return typeof shell === "string" && shell.startsWith("/") ? shell : null;
  } catch {
    return null;
  }
}

/**
 * Last resort. Sourcing the platform's default shell still runs the user's own
 * rc file, which is where a version manager puts itself — so this recovers nvm
 * even when we could not discover which shell they actually chose.
 */
function defaultShell(): string {
  return platform() === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function mergePaths(...groups: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const dir of group.split(":")) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

/**
 * Widen `process.env.PATH` to what the user's shell would give, so every
 * child this process spawns can find the tools the user expects.
 *
 * Best-effort by design: a machine where the shell cannot be read still gets
 * the fallback directories, and a stdio server whose command genuinely is not
 * installed still fails — with a better message, from the manager.
 */
export async function installUserPath(): Promise<void> {
  // Windows has no equivalent problem: a GUI process there inherits the full
  // user and system PATH from the registry.
  if (platform() === "win32") return;

  // $SHELL is set by a terminal, and a GUI launch is not a terminal — so fall
  // back to the login shell in the password database, which is where the
  // terminal got it from in the first place.
  const shell = process.env.SHELL ?? loginShellFromPasswd() ?? defaultShell();
  const fromShell = shell ? await askLoginShell(shell) : null;


  const merged = mergePaths(fromShell ?? "", process.env.PATH ?? "", fallbackDirs().join(":"));
  process.env.PATH = merged;

  logger.info(
    fromShell
      ? `PATH resolved from ${shell} (${merged.split(":").length} entries)`
      : `PATH could not be read from a shell; using inherited plus fallbacks (${merged.split(":").length} entries)`,
  );
}
