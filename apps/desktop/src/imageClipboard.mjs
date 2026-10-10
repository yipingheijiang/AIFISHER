const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

/** Accept image bytes only; never resolve a renderer-supplied file path or URL. */
export function writeClipboardImage(bytes, { clipboard, ClipboardItem, nativeImage }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 45 || bytes.byteLength > MAX_BYTES)
    throw new Error('图片为空或超过剪贴板大小限制。');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR' || !buffer.subarray(-12).equals(PNG_END))
    throw new Error('剪贴板只接受完整的 PNG 图片。');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS)
    throw new Error('图片尺寸超过剪贴板限制。');
  const image = nativeImage.createFromBuffer(buffer);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== width || size.height !== height)
    throw new Error('图片无法解码，请重新复制。');
  if (typeof clipboard.writeImage === 'function') {
    clipboard.writeImage(image);
    return;
  }
  // New Electron releases expose the asynchronous, image/png ClipboardItem API.
  if (typeof clipboard.write !== 'function' || !ClipboardItem)
    throw new Error('当前桌面环境不支持图片剪贴板。');
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([buffer], { type: 'image/png' }) })]);
}
