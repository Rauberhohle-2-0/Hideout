/**
 * Renderer adapter for the privileged Vantail window APIs.
 *
 * This is the only renderer module allowed to import `@vantail/api`. Feature
 * modules (title bar, code-block copy) go through these thin wrappers so the
 * platform surface stays one small, reviewable file. Everything here is a
 * pass-through — no app logic lives in this module.
 */
import { appWindow, clipboard, titleBarMetrics } from '@vantail/api'

/** Tell the runtime to start dragging the window (custom title bar). */
export function startWindowDrag(): void {
  void appWindow?.startDragging()
}

/** Position the macOS traffic lights relative to the custom title bar. */
export function setTrafficLightPosition(x: number, y: number): void {
  void appWindow?.setTrafficLightPosition(x, y)
}

/** Native title-bar metrics (height, button height) for alignment math. */
export function getTitleBarMetrics(): { height?: number; buttonHeight?: number } {
  return titleBarMetrics() ?? {}
}

/** Copy text to the system clipboard (code-block copy buttons). */
export async function writeClipboardText(text: string): Promise<void> {
  await clipboard.writeText(text)
}
