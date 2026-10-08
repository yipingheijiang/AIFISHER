const STYLE_ID = 'fisherai-project-dashboard-chrome';
const DASHBOARD_SELECTOR = '[data-fisherai-project-dashboard="true"]';
const SETTINGS_BUTTON_SELECTOR = '[data-fisherai-dashboard-settings="true"]';
const PROJECT_COVER_IMAGE = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:[?#]|$)/iu;

let stopDashboardObservation: (() => void) | null = null;

function installStyleSheet() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ${DASHBOARD_SELECTOR} {
      height: 100dvh;
      min-height: 0 !important;
      overflow: hidden;
    }

    ${DASHBOARD_SELECTOR} > div:first-child {
      flex: 0 0 auto;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"] {
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      scrollbar-color: var(--af-scrollbar) var(--af-surface);
      scrollbar-width: thin;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar {
      width: 10px;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar-track {
      background: var(--af-input);
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar-thumb {
      background: var(--af-hover);
      border: 2px solid var(--af-border);
      border-radius: 999px;
    }

    [data-fisherai-project-cover="true"] {
      position: relative;
      background: var(--af-input);
    }

    [data-fisherai-project-cover-state="unavailable"] img {
      display: none !important;
    }

    [data-fisherai-project-cover-state="unavailable"]::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--af-input) url('/aifisher-mark-white.svg') center / 34px auto no-repeat;
      opacity: .24;
    }
    html[data-af-theme="light"] [data-fisherai-project-cover-state="unavailable"]::after {
      background-image: url('/aifisher-mark-black.svg');
    }

    ${DASHBOARD_SELECTOR} > div:first-child { height: 64px !important; padding-inline: 32px !important; gap: 20px; border-bottom: 1px solid var(--af-border); }
    ${DASHBOARD_SELECTOR} > main { max-width: 1400px !important; width: 100%; padding: 36px 40px !important; }
    ${DASHBOARD_SELECTOR} > div:first-child h1 { font-size: 16px !important; font-weight: 650; }
    ${DASHBOARD_SELECTOR} > div:first-child > div:last-child { gap: 10px !important; }
    ${DASHBOARD_SELECTOR} > div:first-child button, ${DASHBOARD_SELECTOR} > div:first-child input { min-height: 38px; font-size: 13px; }
    .fisherai-dashboard-settings { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 8px 12px; border: 1px solid var(--af-border); border-radius: 8px; background: var(--af-surface-raised); color: var(--af-text); font-size: 13px; cursor: pointer; }
    .fisherai-dashboard-settings svg { width: 16px; height: 16px; }
    .fisherai-dashboard-settings:hover { background: var(--af-surface-raised); }
    @media (max-width: 1050px) {
      ${DASHBOARD_SELECTOR} > div:first-child { flex-wrap: wrap; height: auto !important; min-height: 64px; padding: 14px 20px !important; gap: 12px; }
      ${DASHBOARD_SELECTOR} > div:first-child > div:last-child { width: 100%; flex-wrap: wrap; justify-content: flex-start; }
      ${DASHBOARD_SELECTOR} > main { padding: 24px !important; }
    }

    @media (prefers-reduced-motion: reduce) {
      .fisherai-dashboard-settings {
        transition: none;
      }
    }
  `;
  document.head.append(style);
}

function createSettingsButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fisherai-dashboard-settings';
  button.dataset.fisheraiDashboardSettings = 'true';
  button.setAttribute('aria-label', '设置');
  button.title = '设置';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);

  const label = document.createElement('span');
  label.className = 'fisherai-dashboard-settings__label';
  label.textContent = '设置';
  button.append(svg, label);
  button.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
  });
  return button;
}

export function projectCoverPreviewUrl(source: string): string | null {
  const value = String(source || '').trim();
  if (!value || value.startsWith('/api/media/thumbnail?')) return value || null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/library/')) {
      return null;
    }
    const localUrl = `${parsed.pathname}${parsed.search}`;
    if (!PROJECT_COVER_IMAGE.test(localUrl)) return null;
    return `/api/media/thumbnail?url=${encodeURIComponent(localUrl)}&max=960`;
  } catch {
    return null;
  }
}

function enhanceProjectCovers(projectMain: HTMLElement) {
  projectMain.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const container = image.parentElement;
    if (!container || image.dataset.fisheraiProjectCover === 'true') return;
    image.dataset.fisheraiProjectCover = 'true';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    container.dataset.fisheraiProjectCover = 'true';
    const preview = projectCoverPreviewUrl(image.getAttribute('src') || '');
    if (!preview) {
      container.dataset.fisheraiProjectCoverState = 'unavailable';
      return;
    }
    image.src = preview;
    image.addEventListener(
      'error',
      () => {
        container.dataset.fisheraiProjectCoverState = 'unavailable';
      },
      { once: true },
    );
  });
}

function reconcileProjectDashboard() {
  const candidates = document.querySelectorAll<HTMLElement>('div.min-h-screen');
  const dashboard = Array.from(candidates).find((candidate) => {
    const directChildren = Array.from(candidate.children);
    const header = directChildren.find((child) => child.matches('div.h-20'));
    const main = directChildren.find((child) => child.tagName === 'MAIN');
    return Boolean(
      header &&
      main &&
      header.querySelector('img[src*="aifisher-mark"], img[src*="aifisher-logo"]'),
    );
  });
  const header = dashboard
    ? Array.from(dashboard.children).find(
        (child): child is HTMLElement => child instanceof HTMLElement && child.matches('div.h-20'),
      )
    : null;
  if (!header || !dashboard) return;

  dashboard.dataset.fisheraiProjectDashboard = 'true';
  const projectMain = Array.from(dashboard.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.tagName === 'MAIN',
  );
  if (projectMain) {
    projectMain.dataset.fisheraiProjectScroll = 'true';
    enhanceProjectCovers(projectMain);
  }

  const toolbar = header.lastElementChild;
  if (!(toolbar instanceof HTMLElement)) return;
  if (!toolbar.querySelector(SETTINGS_BUTTON_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createSettingsButton(), newProject ?? null);
  }
}

export function installProjectDashboardChrome() {
  installStyleSheet();
  reconcileProjectDashboard();
  if (stopDashboardObservation) return;
  stopDashboardObservation = observeStableEnhancement(reconcileProjectDashboard);
}

export function uninstallProjectDashboardChromeForTests() {
  stopDashboardObservation?.();
  stopDashboardObservation = null;
  document.getElementById(STYLE_ID)?.remove();
  document.querySelectorAll(SETTINGS_BUTTON_SELECTOR).forEach((element) => element.remove());
  document.querySelectorAll(DASHBOARD_SELECTOR).forEach((element) => {
    delete (element as HTMLElement).dataset.fisheraiProjectDashboard;
  });
}
import { observeStableEnhancement } from '../lifecycle/enhancementLifecycle';
