import '../../../server/security/installOutboundPolicy.js';
import { checkOutbound } from '../../../server/security/installOutboundPolicy.js';
// One Electron main process owns the window, tray, local workspace and backend.
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
  session,
  protocol,
  safeStorage,
  shell,
  Tray,
  utilityProcess,
  WebContentsView,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppProtocolHandler } from './appProtocol.mjs';
import {
  createBackendEnvironment,
  loadReleaseHelpers,
} from './backendEnvironment.mjs';
import { createBackendSupervisor } from './backendSupervisor.mjs';
import { releasePaths, resolveInstallation } from './installation.mjs';
import { createTray } from './tray.mjs';
import {
  CANVAS_URL,
  LAUNCHER_URL,
  createMainWindow,
  isAppUrl,
  isExternalUrl,
} from './windowManager.mjs';
import { chooseLocalWorkspace, createLocalWorkspace } from './localWorkspace.mjs';
import { writeClipboardImage } from './imageClipboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const installation = resolveInstallation({
  packaged: app.isPackaged,
  executablePath: process.execPath,
  sourceRoot: path.resolve(here, '..', '..', '..'),
});
const BACKEND_RETRY_DELAY_MS = 30_000;
const OPEN_FAILED = '本机服务未能启动，请重试。你的项目仍保存在本机。';

// Chromium's cache and storage stay with the rest of AIFISHER's local state instead of Roaming.
// The single-instance lock below is keyed on this folder, so it must be set first.
app.setPath('userData', path.join(installation.state, 'chromium'));
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
const primaryInstance = app.requestSingleInstanceLock();
// Stop, upgrade and uninstall scripts start a second copy with --quit to close the running one
// gracefully; closing the window only hides it to the tray.
const quitRequested = process.argv.includes('--quit');

let helpers = null;
let mainWindow = null;
let tray = null;
let appContents = null;
let workspace = null;
let backend = null;
let productVersion = app.getVersion();
let quitting = false;
let canvasOpen = false;
let backendRetryTimer = null;
let workspaceSwitch = null;

async function selectWorkspace(forceChoice = false) {
  return chooseLocalWorkspace({
    usersDirectory: path.join(installation.data, 'users'), forceChoice,
    choose: async (ids) => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '选择本机工作区',
        message: '选择要使用的本机项目和 API Key。',
        detail: '工作区分别保留，不会合并或删除原数据。',
        buttons: [...ids.map((id, index) => `工作区 ${index + 1} · ${id.slice(0, 8)}`), '新建本地工作区', '取消'],
        cancelId: ids.length + 1, noLink: true,
      });
      return result.response === ids.length ? 'new' : ids[result.response];
    },
  });
}

function broadcast(channel, payload) {
  if (appContents && !appContents.isDestroyed()) appContents.send(channel, payload);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  appContents?.focus();
}

function senderPath(event) {
  const url = event.senderFrame?.url ?? '';
  if (!isAppUrl(url)) throw new Error('UNTRUSTED_SENDER');
  return new URL(url).pathname;
}

function handle(channel, work, { launcherOnly = false } = {}) {
  ipcMain.handle(channel, (event, ...args) => {
    const pathname = senderPath(event);
    if (launcherOnly && !pathname.startsWith('/launcher/')) throw new Error('UNTRUSTED_SENDER');
    return work(...args);
  });
}

function backendView() {
  return backend?.state() === 'ready' ? 'ready' : 'reconnecting';
}

function keepCanvasAlive() {
  clearTimeout(backendRetryTimer);
  backendRetryTimer = null;
}

function onBackendState(state) {
  broadcast('backend:state', backendView());
  if (state !== 'failed' || !canvasOpen) return;
  // The supervisor gave up after repeated crashes. The page and its unsaved edits stay put behind
  // the reconnect notice while the backend is retried slowly.
  clearTimeout(backendRetryTimer);
  backendRetryTimer = setTimeout(() => {
    const userId = backend.userId();
    if (canvasOpen && userId) void backend.start(userId).catch(() => {});
  }, BACKEND_RETRY_DELAY_MS);
}

async function createWorkspace() {
  return createLocalWorkspace({
    filePath: path.join(installation.state, 'local-workspace.json'),
    legacyDevicePath: path.join(installation.state, 'device-identity.bin'),
    decryptString: bytes => safeStorage.decryptString(bytes),
    resolveLocalUser: () => installation.devUserId || selectWorkspace(),
  });
}

async function openCanvas() {
  const userId = workspace.userId();
  if (!userId) return { opened: false, message: '本机工作区尚未就绪，请重试。' };
  try {
    await backend.start(userId);
  } catch {
    return { opened: false, message: OPEN_FAILED };
  }
  canvasOpen = true;
  // The canvas loads after the backend is ready, so its preferences hydrate on first paint.
  await appContents.loadURL(CANVAS_URL);
  mainWindow.setTitle('AIFISHER 画布');
  return { opened: true, message: '画布已打开。' };
}

function registerIpc() {
  ipcMain.on('desktop:version', (event) => {
    event.returnValue = productVersion;
  });
  handle('shell:info', () => ({
    version: app.getVersion(),
    productVersion,
    platform: 'windows',
    architecture: process.arch,
  }));
  handle('shell:open-external', (url) =>
    isExternalUrl(url) ? shell.openExternal(checkOutbound(url).href) : undefined,
  );
  handle('workspace:restore', () => workspace.restore(), { launcherOnly: true });
  handle(
    'canvas:prepare',
    () => {
      const userId = workspace.userId();
      if (!userId) return { prepared: false, message: '本机工作区尚未就绪，请重试。' };
      void backend.start(userId).catch(() => {});
      return { prepared: true, message: '' };
    },
    { launcherOnly: true },
  );
  handle('canvas:open', () => openCanvas(), { launcherOnly: true });
  handle('backend:current-state', () => backendView());
  handle('desktop:switch-workspace', () => {
    workspaceSwitch ??= (async () => {
      if (quitting) throw new Error('退出过程中暂不能切换工作区');
      const selected = await selectWorkspace(true);
      if (selected === workspace.userId()) return;
      if (quitting) throw new Error('退出过程中暂不能切换工作区');
      const previous = workspace.userId();
      keepCanvasAlive(false);
      await backend.stop();
      try {
        await workspace.selectLocalUser(selected);
        const opened = await openCanvas();
        if (!opened.opened) throw new Error(opened.message);
      } catch (error) {
        await backend.stop();
        await workspace.selectLocalUser(previous);
        await openCanvas();
        throw error;
      }
    })().finally(() => { workspaceSwitch = null; });
    return workspaceSwitch;
  });
  handle('desktop:show-item-in-folder', (target) => shell.showItemInFolder(target));
  let clipboardWrite = Promise.resolve();
  ipcMain.handle('desktop:copy-image', (event, bytes) => {
    if (!appContents || event.sender !== appContents || event.senderFrame !== appContents.mainFrame || senderPath(event) !== '/')
      throw new Error('UNTRUSTED_SENDER');
    const write = clipboardWrite.catch(() => {}).then(() => writeClipboardImage(bytes, { clipboard, ClipboardItem, nativeImage }));
    clipboardWrite = write;
    return write;
  });
}

async function start() {
  helpers = await loadReleaseHelpers(installation.tools);
  productVersion = await Promise.resolve()
    .then(() => helpers.loadProductVersion(releasePaths(installation)))
    .catch(() => app.getVersion());
  workspace = await createWorkspace();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try { checkOutbound(details.url); callback({ cancel: false }); }
    catch { callback({ cancel: true }); }
  });
  backend = createBackendSupervisor({
    fork: (...args) => utilityProcess.fork(...args),
    entry: installation.server,
    cwd: installation.code,
    logsDirectory: installation.logs,
    createEnvironment: ({ userId, pipe }) =>
      createBackendEnvironment({ installation, userId, pipe, helpers }),
  });
  backend.onState(onBackendState);
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({
      backend,
      distDirectory: installation.dist,
      launcherDirectory: installation.launcher,
    }),
  );
  registerIpc();

  // Launcher starts dark; the canvas later applies its workspace theme to native window chrome.
  nativeTheme.themeSource = 'dark';
  ({ window: mainWindow, contents: appContents } = createMainWindow({
    BrowserWindow,
    WebContentsView,
    shell,
    ipcMain,
    nativeTheme,
    preload: path.join(here, 'preload.cjs'),
    icon: installation.icon,
  }));
  mainWindow.on('close', (event) => {
    if (quitting) return;
    // Closing hides to the tray; the canvas, its unsaved edits and the backend stay alive.
    event.preventDefault();
    mainWindow.hide();
    broadcast('shell:clear-secrets');
  });
  tray = createTray({
    Tray,
    Menu,
    icon: installation.icon,
    onShow: showWindow,
    onQuit: () => app.quit(),
  });

  if (installation.devUserId) {
    await workspace.restore();
    await workspace.selectLocalUser(installation.devUserId);
    await openCanvas();
  } else {
    await appContents.loadURL(LAUNCHER_URL);
  }
}

if (!primaryInstance || quitRequested) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) app.quit();
    else showWindow();
  });
  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (!backend || backend.state() === 'stopped') return;
    event.preventDefault();
    keepCanvasAlive(false);
    void backend.stop().finally(() => app.quit());
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error('AIFISHER 启动失败', error);
      app.exit(1);
    });
}
