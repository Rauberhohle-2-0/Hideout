import type { Api } from "../shared/api.ts";

declare global {
  interface Window {
    api: Api;
  }
}

function setHelloWorld(text: string): void {
  const el = document.getElementById("hello");
  if (el) el.textContent = text;
}

async function init(): Promise<void> {
  // Fallback to hardcoded Hello World if API not available (e.g., opened without preload)
  let message = "Hello World";
  try {
    if (window.api?.getHelloWorld) {
      message = await window.api.getHelloWorld();
    }
  } catch {
    message = "Hello World";
  }

  setHelloWorld(message);
  // Required: print Hello World in the renderer (console and visible DOM)
  console.log(message);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
