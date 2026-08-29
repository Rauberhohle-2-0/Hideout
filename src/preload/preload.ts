import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type Api } from "../shared/api.ts";

// Minimal, validated IPC API - Renderer = untrusted
// Never expose ipcRenderer directly, shell, fs, or Node access.
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
};

contextBridge.exposeInMainWorld("api", api);
