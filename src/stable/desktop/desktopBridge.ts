/** Local desktop capabilities exposed by the Electron preload. */
export interface AifisherDesktopBridge {
  readonly version: string;
  readonly integratedTitleBar?: boolean;
  /** Optional for older desktop shells; only affects native chrome, not stored preferences. */
  setTheme?(theme: 'dark' | 'light'): Promise<void>;
  switchWorkspace?(): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  /** Writes PNG pixels to the system clipboard, without granting filesystem access. */
  copyImage?(bytes: Uint8Array): Promise<void>;
  pathForFile(file: File): string; // 没有本机路径时返回 ''
  onBackendState(listener: (state: 'ready' | 'reconnecting') => void): () => void;
}

declare global {
  interface Window {
    aifisherDesktop?: AifisherDesktopBridge;
  }
}

export function desktopBridge(windowObject: Window | null = window): AifisherDesktopBridge | null {
  return windowObject?.aifisherDesktop ?? null;
}
