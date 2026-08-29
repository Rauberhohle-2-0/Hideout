import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type Api } from "../shared/api.ts";

// Minimal, validated IPC API - Renderer = untrusted
// Never expose ipcRenderer directly, shell, fs, or Node access.
function assertString(v: unknown, label: string): string {
  if (typeof v !== "string") throw new Error(`Invalid ${label}`);
  return v;
}

const api: Api = {
  getHelloWorld: async (): Promise<string> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.HELLO_WORLD);
    if (typeof result !== "string") throw new Error("Invalid response");
    return result;
  },
  ping: async (): Promise<string> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.PING);
    if (typeof result !== "string") throw new Error("Invalid response");
    return result;
  },
  aiListProviders: async () => {
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_PROVIDERS);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Api extends { aiListProviders(): Promise<infer T> } ? T : never;
  },
  aiHealth: async (providerId: string) => {
    assertString(providerId, "providerId");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_HEALTH, providerId);
    if (!res || typeof res !== "object" || typeof (res as { ok: unknown }).ok !== "boolean") {
      throw new Error("Invalid response");
    }
    return res as Awaited<ReturnType<Api["aiHealth"]>>;
  },
  aiListModels: async (providerId: string) => {
    assertString(providerId, "providerId");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_MODELS, providerId);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["aiListModels"]>>;
  },
  aiChat: async (req) => {
    if (!req || typeof req.providerId !== "string" || !Array.isArray(req.messages)) {
      throw new Error("Invalid request");
    }
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_CHAT, req);
    if (!res || typeof (res as { content: unknown }).content !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["aiChat"]>>;
  },
};

contextBridge.exposeInMainWorld("api", api);
