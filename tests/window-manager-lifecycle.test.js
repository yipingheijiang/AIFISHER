import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createMainWindow, CANVAS_URL, LAUNCHER_URL } from '../apps/desktop/src/windowManager.mjs';

class Contents extends EventEmitter {
  destroyed = false;
  url = CANVAS_URL;
  frame = { url: CANVAS_URL };
  isDestroyed() { return this.destroyed; }
  check() { if (this.destroyed) throw new TypeError('Object has been destroyed'); }
  get mainFrame() { this.check(); return this.frame; }
  getURL() { this.check(); return this.url; }
  executeJavaScript = vi.fn(() => { this.check(); return Promise.resolve(); });
  focus = vi.fn(() => this.check());
  setWindowOpenHandler = vi.fn(() => this.check());
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}
class Window extends EventEmitter {
  destroyed = false;
  hostContents = new Contents();
  contentView = { addChildView: view => { this.view = view; } };
  isDestroyed() { return this.destroyed; }
  check() { if (this.destroyed) throw new TypeError('Object has been destroyed'); }
  get webContents() { this.check(); return this.hostContents; }
  getContentBounds = vi.fn(() => { this.check(); return { width: 1180, height: 820 }; });
  removeMenu = vi.fn();
  setTitleBarOverlay = vi.fn(() => this.check());
  setBackgroundColor = vi.fn(() => this.check());
  maximize = vi.fn(() => this.check());
  show = vi.fn(() => this.check());
  loadURL = vi.fn(() => Promise.resolve());
  destroy() { this.destroyed = true; this.emit('closed'); this.hostContents.destroy(); }
}
class View {
  webContents = new Contents();
  setBackgroundColor = vi.fn(() => this.webContents.check());
  setBounds = vi.fn(() => this.webContents.check());
}
function fixture() {
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: vi.fn(name => handlers.delete(name)) };
  const nativeTheme = { themeSource: 'dark' };
  const shell = { openExternal: vi.fn() };
  const { window, contents } = createMainWindow({ BrowserWindow: Window, WebContentsView: View, shell, ipcMain, nativeTheme });
  const theme = handlers.get('desktop:set-theme');
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { window, contents, host: window.webContents, handlers, theme, event, nativeTheme };
}

describe('main window lifecycle callbacks', () => {
  it('does not access a destroyed BrowserWindow from a late did-navigate callback', () => {
    const f = fixture();
    f.contents.emit('did-navigate', {}, CANVAS_URL);
    const late = f.contents.listeners('did-navigate')[0];
    f.window.destroy();
    expect(() => late({}, CANVAS_URL)).not.toThrow();
  });

  it('ignores a captured navigation-start callback after the host window is destroyed', () => {
    const f = fixture(), late = f.contents.listeners('did-start-navigation')[0];
    f.window.destroy();
    expect(() => late({ url: LAUNCHER_URL, isSameDocument: false, isMainFrame: true })).not.toThrow();
  });

  it('ignores captured resize, focus and ready-to-show callbacks after window destruction', () => {
    const f = fixture();
    const callbacks = ['resize', 'focus', 'ready-to-show'].map(name => f.window.listeners(name)[0]);
    f.window.destroy();
    for (const callback of callbacks) expect(() => callback()).not.toThrow();
  });

  it('ignores a late title-strip DOM callback without invoking destroyed WebContents', () => {
    const f = fixture(), late = f.host.listeners('dom-ready')[0];
    f.window.destroy();
    f.host.executeJavaScript.mockClear();
    expect(() => late()).not.toThrow();
    expect(f.host.executeJavaScript).not.toHaveBeenCalled();
  });

  it('ignores resize and focus if only the canvas WebContents has been destroyed', () => {
    const f = fixture(), resize = f.window.listeners('resize')[0], focus = f.window.listeners('focus')[0];
    f.contents.destroy();
    expect(f.window.isDestroyed()).toBe(false);
    expect(() => resize()).not.toThrow();
    expect(() => focus()).not.toThrow();
  });

  it.each(['window', 'canvas', 'host'])('rejects late theme IPC after %s destruction before reading destroyed native objects', target => {
    const f = fixture();
    if (target === 'window') f.window.destroy();
    else if (target === 'canvas') f.contents.destroy();
    else f.host.destroy();
    expect(() => f.theme(f.event, 'light')).toThrow('UNTRUSTED_SENDER');
    expect(f.nativeTheme.themeSource).toBe('dark');
  });

  it('removes window, navigation, DOM and theme subscriptions when the window actually closes', () => {
    const f = fixture();
    f.window.destroy();
    for (const name of ['resize', 'focus', 'ready-to-show']) expect(f.window.listenerCount(name)).toBe(0);
    for (const name of ['did-start-navigation', 'did-navigate']) expect(f.contents.listenerCount(name)).toBe(0);
    expect(f.host.listenerCount('dom-ready')).toBe(0);
    expect(f.handlers.has('desktop:set-theme')).toBe(false);
  });

  it('keeps cancelled close/hidden windows live for navigation, theme and focus', () => {
    const f = fixture();
    f.window.emit('close', { preventDefault: vi.fn() });
    f.contents.url = LAUNCHER_URL;
    f.contents.emit('did-navigate', {}, LAUNCHER_URL);
    expect(f.window.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 32, width: 1180, height: 788 });
    f.contents.url = CANVAS_URL;
    f.contents.emit('did-navigate', {}, CANVAS_URL);
    expect(f.window.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1180, height: 820 });
    f.theme(f.event, 'light');
    expect(f.nativeTheme.themeSource).toBe('light');
    expect(f.window.setBackgroundColor).toHaveBeenLastCalledWith('#f6f7f9');
    f.window.emit('focus'); expect(f.contents.focus).toHaveBeenCalled();
    expect(() => f.theme({ ...f.event, sender: new Contents() }, 'dark')).toThrow('UNTRUSTED_SENDER');
    expect(() => f.theme(f.event, 'invalid')).toThrow('INVALID_THEME');
  });
});
