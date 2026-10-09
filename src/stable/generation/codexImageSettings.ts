import { createStableTextElement as textElement } from '../design/dom';
import { createCodexClient } from '../agent/codexClient';
import type { SettingsScope } from './sourceSettingsScope';

export function codexImageSettings(scope: SettingsScope) {
  const client = createCodexClient();
  const card = document.createElement('section');
  card.setAttribute('data-fisherai-source-block', 'codex');
  card.className = 'rounded-lg border border-[var(--af-border)] bg-[var(--af-surface-raised)] p-6 space-y-3';
  card.append(textElement('h3', 'Codex 内置生图', 'text-xl font-bold text-[var(--af-text)]'));
  card.append(textElement('p', '使用 Codex 的 ChatGPT 账号额度，不需要第三方 API Key。连接后在图片节点选择「Codex 内置生图」；支持文生图和最多 5 张本地参考图，每次一张。实际模型和图片尺寸由 Codex 提供。', 'text-sm text-[var(--af-text-secondary)]'));
  const state = textElement('p', '正在检测 Codex 连接…', 'text-sm text-[var(--af-text-secondary)]');
  state.setAttribute('role', 'status');
  const controls = document.createElement('div');
  controls.className = 'flex flex-wrap gap-3';
  const connect = textElement('button', '连接 Codex', 'fisherai-button is-primary') as HTMLButtonElement;
  const refresh = textElement('button', '刷新连接状态', 'fisherai-button') as HTMLButtonElement;
  const setup = textElement('button', '复制本机连接指引', 'fisherai-button') as HTMLButtonElement;
  connect.type = refresh.type = setup.type = 'button';
  const guide = document.createElement('textarea');
  guide.readOnly = true; guide.hidden = true; guide.className = 'w-full h-28 fisherai-input';
  guide.setAttribute('aria-label', 'Codex 本机连接指引');
  let busy = false, connected: boolean | undefined;
  async function status() {
    if (!scope.active() || busy) return;
    busy = true;
    try {
      const info = await client.status(scope.signal);
      if (!scope.active()) return;
      state.textContent = info.connected ? '已连接 · 生图使用 Codex 账户额度，系统不会自动重试失败任务。'
        : info.loginPending ? '等待浏览器授权，完成后将自动更新。'
          : info.installed ? '尚未连接，请登录你的 ChatGPT 账号。' : '未找到 Codex，请复制本机连接指引到 Codex 桌面对话。';
      connect.disabled = !info.installed || info.connected;
      connect.textContent = info.loginPending ? '重新打开授权页' : '连接 Codex';
      if (connected !== info.connected) {
        connected = info.connected;
        window.dispatchEvent(new CustomEvent('fisherai:model-sources-changed'));
      }
    } catch (error) { if (scope.active()) state.textContent = error instanceof Error ? error.message : 'Codex 状态读取失败，请刷新。'; }
    finally { busy = false; }
  }
  connect.addEventListener('click', () => {
    if (busy || !scope.active()) return;
    connect.disabled = true;
    void client.login(scope.signal).then(() => client.openLogin(scope.signal)).then(() => status())
      .catch((error: unknown) => { if (scope.active()) state.textContent = error instanceof Error ? error.message : '授权页未能打开，请重试。'; })
      .finally(() => { if (scope.active()) connect.disabled = connected === true; });
  });
  refresh.addEventListener('click', () => void status());
  setup.addEventListener('click', () => {
    if (busy || !scope.active()) return;
    setup.disabled = true;
    void client.setup(scope.signal).then(async result => {
      if (!scope.active()) return;
      guide.value = result.prompt; guide.hidden = false;
      try { await navigator.clipboard.writeText(result.prompt); state.textContent = '连接指引已复制，请粘贴到本机 Codex 对话发送。'; }
      catch { state.textContent = '请手动复制下方连接指引到本机 Codex 对话。'; }
    }).catch((error: unknown) => { if (scope.active()) state.textContent = error instanceof Error ? error.message : '读取指引失败。'; })
      .finally(() => { if (scope.active()) setup.disabled = false; });
  });
  controls.append(connect, refresh, setup);
  card.append(state, controls, guide);
  const timer = setInterval(() => void status(), 5000);
  scope.onDispose(() => clearInterval(timer));
  // The settings root is attached immediately after the caller returns.
  queueMicrotask(() => void status());
  return card;
}
