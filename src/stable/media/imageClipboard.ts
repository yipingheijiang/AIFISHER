import { desktopBridge } from '../desktop/desktopBridge';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
let copyRevision = 0;
let pendingRead: AbortController | undefined;

export function canvasClipboardImageSource(nodes: readonly { type: string; status?: unknown; resultUrl?: unknown }[]): string | undefined {
  const node = nodes.length === 1 ? nodes[0] : undefined;
  return node && ['Image', 'Upload Image'].includes(node.type) && !['queued', 'loading'].includes(String(node.status)) &&
    typeof node.resultUrl === 'string' && node.resultUrl ? node.resultUrl : undefined;
}

async function readImage(url: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('读取图片失败，请确认图片仍可访问。');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('图片超过 32 MB，无法复制到剪贴板。');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片为空或超过 32 MB。');
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('图片超过 32 MB，无法复制到剪贴板。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new Error('图片内容为空。');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function pngForClipboard(url: string, signal: AbortSignal): Promise<Blob> {
  const bytes = await readImage(url, signal);
  if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('图片尺寸超过剪贴板限制。');
    return new Blob([bytes], { type: 'image/png' });
  }
  const image = await createImageBitmap(new Blob([bytes]));
  try {
    if (!image.width || !image.height || image.width * image.height > MAX_PIXELS) throw new Error('图片尺寸超过剪贴板限制。');
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法准备剪贴板图片。');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('图片无法转换为 PNG。')), 'image/png',
    ));
    if (png.size > MAX_BYTES) throw new Error('图片超过 32 MB，无法复制到剪贴板。');
    return png;
  } finally { image.close(); }
}

/** A newer copy owns the clipboard; a late image read must not replace it. */
export async function copyCanvasImageToClipboard(url: string): Promise<boolean> {
  const revision = ++copyRevision;
  pendingRead?.abort();
  const abort = new AbortController();
  pendingRead = abort;
  try {
    const bridge = desktopBridge();
    if (bridge?.copyImage) {
      const bytes = new Uint8Array(await (await pngForClipboard(url, abort.signal)).arrayBuffer());
      if (revision !== copyRevision) return false;
      await bridge.copyImage(bytes);
    } else {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('当前环境不支持图片剪贴板，请使用新版桌面应用。');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngForClipboard(url, abort.signal).then(blob => {
        if (revision !== copyRevision) throw new DOMException('Copy superseded', 'AbortError');
        return blob;
      }) })]);
    }
    return revision === copyRevision;
  } catch (error) {
    if (revision !== copyRevision) return false;
    throw error;
  } finally { if (revision === copyRevision) pendingRead = undefined; }
}
