import type { OpenCanvasResult, PrepareCanvasResult } from './canvasEntry';
export interface AifisherShell {
  info(): Promise<{ version: string; productVersion: string | null; platform: string; architecture: string }>;
  workspace: { restore(): Promise<{ state: 'ready'; message: string }> };
  canvas: {
    prepare(): Promise<PrepareCanvasResult>;
    open(userInitiated: boolean): Promise<OpenCanvasResult>;
  };
  openExternal(url: string): Promise<void>;
  onClearSecrets(listener: () => void): () => void;
}
declare global { interface Window { aifisherShell?: AifisherShell } }
export function desktopShell(): AifisherShell {
  const shell = window.aifisherShell;
  if (!shell) throw new Error('AIFISHER 桌面环境不可用。');
  return shell;
}
