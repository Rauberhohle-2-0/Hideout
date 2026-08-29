/** Shared types and constants between Main, Preload and Renderer - security boundary types. */

export const HELLO_WORLD = "Hello World";

export const IPC_CHANNELS = {
  HELLO_WORLD: "hello-world",
  PING: "ping",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Minimal API exposed to renderer via contextBridge */
export interface Api {
  getHelloWorld(): Promise<string>;
  ping(): Promise<string>;
}

declare global {
  interface Window {
    api: Api;
  }
}
