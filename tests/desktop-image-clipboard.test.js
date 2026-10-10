import { describe, expect, it, vi } from 'vitest';
import { writeClipboardImage } from '../apps/desktop/src/imageClipboard.mjs';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgybvTAMIMGAwAj3MLBTclv98AAAAASUVORK5CYII=', 'base64'));

function nativeMocks(options = {}) {
  const image = {
    isEmpty: vi.fn(() => Boolean(options.empty)),
    getSize: vi.fn(() => options.size || { width: 2, height: 3 }),
  };
  return {
    image,
    clipboard: { writeImage: vi.fn() },
    nativeImage: { createFromBuffer: vi.fn(() => image) },
  };
}

describe('native image-only clipboard boundary', () => {
  it('decodes complete original PNG bytes and writes the NativeImage exactly once', () => {
    const x = nativeMocks();
    writeClipboardImage(PNG, x);
    expect(x.nativeImage.createFromBuffer).toHaveBeenCalledOnce();
    expect([...x.nativeImage.createFromBuffer.mock.calls[0][0]]).toEqual([...PNG]);
    expect(x.clipboard.writeImage).toHaveBeenCalledExactlyOnceWith(x.image);
  });

  it('decodes only the Uint8Array view, without surrounding bytes from its backing buffer', () => {
    const padded = new Uint8Array(PNG.length + 12); padded.fill(255); padded.set(PNG, 7);
    const x = nativeMocks();
    writeClipboardImage(padded.subarray(7, 7 + PNG.length), x);
    expect([...x.nativeImage.createFromBuffer.mock.calls[0][0]]).toEqual([...PNG]);
    expect(x.clipboard.writeImage).toHaveBeenCalledOnce();
  });

  it.each([
    ['path string', 'D:/private/image.png'],
    ['plain text', 'not an image'],
    ['generic array', [...PNG]],
    ['array buffer', PNG.slice().buffer],
    ['empty image', new Uint8Array()],
    ['JPEG bytes', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
    ['truncated PNG signature', PNG.slice(0, 8)],
    ['missing IEND', PNG.slice(0, -12)],
  ])('rejects %s and never writes the clipboard', (_label, bytes) => {
    const x = nativeMocks();
    expect(() => writeClipboardImage(bytes, x)).toThrow();
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects more than 32 MB before asking Electron to decode', () => {
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1); oversized.set(PNG);
    const x = nativeMocks();
    expect(() => writeClipboardImage(oversized, x)).toThrow();
    expect(x.nativeImage.createFromBuffer).not.toHaveBeenCalled();
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects an empty, invalid-sized, or over-40-million-pixel decoded image before write', () => {
    for (const options of [
      { empty: true },
      { size: { width: 0, height: 3 } },
      { size: { width: 2, height: NaN } },
      { size: { width: 8000, height: 6000 } },
    ]) {
      const x = nativeMocks(options);
      expect(() => writeClipboardImage(PNG, x)).toThrow();
      expect(x.clipboard.writeImage).not.toHaveBeenCalled();
    }
  });

  it('propagates decode errors without changing the clipboard', () => {
    const x = nativeMocks();
    x.nativeImage.createFromBuffer.mockImplementation(() => { throw new Error('decoder failure'); });
    expect(() => writeClipboardImage(PNG, x)).toThrow();
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('passes a complete original PNG Blob to the modern API and waits for its write to finish', async () => {
    const x = nativeMocks();
    let finishWrite;
    const pendingWrite = new Promise(resolve => { finishWrite = resolve; });
    const clipboard = { write: vi.fn(() => pendingWrite) };
    class ClipboardItem {
      constructor(data) { this.data = data; }
    }
    const written = writeClipboardImage(PNG, { ...x, clipboard, ClipboardItem });
    let completed = false;
    const completion = Promise.resolve(written).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(clipboard.write).toHaveBeenCalledOnce();
    const items = clipboard.write.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(ClipboardItem);
    expect(Object.keys(items[0].data)).toEqual(['image/png']);
    const blob = items[0].data['image/png'];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...PNG]);
    finishWrite();
    await completion;
    expect(completed).toBe(true);
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('propagates modern asynchronous clipboard write failures to its caller', async () => {
    const x = nativeMocks();
    const failure = new Error('clipboard permission denied');
    const clipboard = { write: vi.fn(async () => { throw failure; }) };
    class ClipboardItem {
      constructor(data) { this.data = data; }
    }
    await expect(writeClipboardImage(PNG, { ...x, clipboard, ClipboardItem })).rejects.toBe(failure);
    expect(clipboard.write).toHaveBeenCalledOnce();
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
  });

  it.each([
    ['neither clipboard image capability', {}, undefined],
    ['a write API without ClipboardItem', { write: vi.fn() }, undefined],
    ['ClipboardItem without a write API', {}, class {}],
  ])('rejects %s instead of silently reporting a completed copy', (_label, clipboard, ClipboardItem) => {
    const x = nativeMocks();
    expect(() => writeClipboardImage(PNG, { ...x, clipboard, ClipboardItem })).toThrow();
    expect(x.clipboard.writeImage).not.toHaveBeenCalled();
    if (clipboard.write) expect(clipboard.write).not.toHaveBeenCalled();
  });
});
