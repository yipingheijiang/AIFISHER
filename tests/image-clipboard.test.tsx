// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { canvasClipboardImageSource, copyCanvasImageToClipboard } from '../src/stable/media/imageClipboard';
import { useCanvasCommands } from '../src/stable/canvas/canvasCommands';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgybvTAMIMGAwAj3MLBTclv98AAAAASUVORK5CYII=', 'base64'));
const SECOND_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWO4o2HzH4QZMBgAtJMNe2OAeDoAAAAASUVORK5CYII=', 'base64'));
const imageNode = { id: 'image', type: 'Image', x: 10, y: 20, resultUrl: '/library/original.png', status: 'success' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function response(bytes = PNG, type = 'image/png', extra = {}) {
  return {
    ok: true, status: 200,
    headers: new Headers({ 'Content-Type': type, 'Content-Length': String(bytes.byteLength) }),
    arrayBuffer: vi.fn(async () => bytes.slice().buffer),
    blob: vi.fn(async () => new Blob([bytes], { type })),
    ...extra,
  };
}

let copyImage, browserWrite, browserImages, bitmap, drawImage, toBlob;
beforeEach(() => {
  copyImage = vi.fn(async () => {});
  Object.defineProperty(window, 'aifisherDesktop', { configurable: true, value: { copyImage } });
  browserImages = [];
  browserWrite = vi.fn(async items => {
    const values = await Promise.all(items.flatMap(item => Object.values(item.data)));
    browserImages.push(...values);
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: browserWrite } });
  vi.stubGlobal('ClipboardItem', class {
    constructor(data) { this.data = data; }
  });
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  bitmap = { width: 2, height: 3, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('OffscreenCanvas', undefined);
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage }));
  toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
    callback(new Blob([PNG], { type: 'image/png' }));
  });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.aifisherDesktop;
  delete window.__FISHERAI_CANVAS_CLIPBOARD__;
});

describe('canvas image clipboard source and system write', () => {
  it('uses only the original result of one ready Image or Upload Image node', () => {
    expect(canvasClipboardImageSource([{ ...imageNode, previewUrl: '/thumb/low-resolution.webp' }])).toBe('/library/original.png');
    expect(canvasClipboardImageSource([{ ...imageNode, type: 'Upload Image' }])).toBe('/library/original.png');
    for (const nodes of [
      [], [imageNode, { ...imageNode, id: 'second' }],
      [{ ...imageNode, type: 'Video' }], [{ ...imageNode, resultUrl: '' }],
      [{ ...imageNode, status: 'queued' }], [{ ...imageNode, status: 'loading' }],
    ]) expect(canvasClipboardImageSource(nodes)).toBeUndefined();
  });

  it('preserves original PNG bytes and alpha through the native bridge without browser re-encoding', async () => {
    expect(await copyCanvasImageToClipboard('/library/original.png')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('/library/original.png');
    expect(copyImage).toHaveBeenCalledOnce();
    expect(copyImage.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect([...copyImage.mock.calls[0][0]]).toEqual([...PNG]);
    expect(toBlob).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('converts non-PNG at its original dimensions and releases the decoded bitmap', async () => {
    fetch.mockResolvedValue(response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'));
    bitmap.width = 1920; bitmap.height = 1080;
    let canvas;
    toBlob.mockImplementation(function (callback) {
      canvas = this;
      callback(new Blob([PNG], { type: 'image/png' }));
    });
    expect(await copyCanvasImageToClipboard('/library/full-size.jpg')).toBe(true);
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(1920); expect(canvas.height).toBe(1080);
    expect(drawImage.mock.calls[0][0]).toBe(bitmap);
    expect([...copyImage.mock.calls[0][0]]).toEqual([...PNG]);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('supports the browser image ClipboardItem fallback for older desktop shells', async () => {
    Object.defineProperty(window, 'aifisherDesktop', { configurable: true, value: { version: 'older-shell' } });
    expect(await copyCanvasImageToClipboard('/library/original.png')).toBe(true);
    expect(browserWrite).toHaveBeenCalledOnce();
    const items = browserWrite.mock.calls[0][0];
    expect(items).toHaveLength(1);
    const blob = await items[0].data['image/png'];
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(PNG.byteLength);
    expect(copyImage).not.toHaveBeenCalled();
  });

  it('rejects fetch/permission failures and never falls back after a native write rejection', async () => {
    fetch.mockRejectedValueOnce(new Error('image unavailable'));
    await expect(copyCanvasImageToClipboard('/library/missing.png')).rejects.toThrow();
    expect(copyImage).not.toHaveBeenCalled();
    copyImage.mockRejectedValueOnce(new Error('native clipboard denied'));
    await expect(copyCanvasImageToClipboard('/library/original.png')).rejects.toThrow();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('rejects failed HTTP and an undecodable image without writing either clipboard', async () => {
    fetch.mockResolvedValueOnce(response(PNG, 'image/png', { ok: false, status: 404 }));
    await expect(copyCanvasImageToClipboard('/library/missing.png')).rejects.toThrow();
    fetch.mockResolvedValueOnce(response(Uint8Array.from([60, 104, 116, 109, 108, 62]), 'text/html'));
    createImageBitmap.mockRejectedValueOnce(new Error('not a decodable image'));
    await expect(copyCanvasImageToClipboard('/library/not-image')).rejects.toThrow();
    expect(copyImage).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('rejects a failed PNG encoder and closes the decoded bitmap without changing the clipboard', async () => {
    fetch.mockResolvedValue(response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'));
    toBlob.mockImplementation(callback => callback(null));
    await expect(copyCanvasImageToClipboard('/library/encode-failure.jpg')).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(copyImage).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('rejects oversized reads, decoded pixels, and PNG output before the system write', async () => {
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1); oversized.set(PNG);
    fetch.mockResolvedValueOnce(response(oversized));
    await expect(copyCanvasImageToClipboard('/library/too-large.png')).rejects.toThrow();
    fetch.mockResolvedValue(response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'));
    bitmap.width = 8000; bitmap.height = 6000;
    await expect(copyCanvasImageToClipboard('/library/too-many-pixels.jpg')).rejects.toThrow();
    bitmap.width = 2; bitmap.height = 3;
    toBlob.mockImplementation(callback => callback(new Blob([oversized], { type: 'image/png' })));
    await expect(copyCanvasImageToClipboard('/library/encoded-too-large.jpg')).rejects.toThrow();
    expect(copyImage).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('enforces the byte cap on a streamed response without a Content-Length hint', async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: false, value: PNG })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(32 * 1024 * 1024) }),
      cancel: vi.fn(async () => {}), releaseLock: vi.fn(),
    };
    fetch.mockResolvedValueOnce(response(PNG, 'image/png', {
      headers: new Headers({ 'Content-Type': 'image/png' }),
      body: { getReader: () => reader },
    }));
    await expect(copyCanvasImageToClipboard('/library/streamed-large.png')).rejects.toThrow();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(copyImage).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('rejects oversized PNG header dimensions before sending bytes to the native bridge', async () => {
    const large = PNG.slice();
    const header = new DataView(large.buffer);
    header.setUint32(16, 8000); header.setUint32(20, 6000);
    fetch.mockResolvedValueOnce(response(large));
    await expect(copyCanvasImageToClipboard('/library/huge-dimensions.png')).rejects.toThrow();
    expect(copyImage).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('does not let a late older fetch overwrite a newer successful image copy', async () => {
    const oldFetch = deferred();
    fetch.mockImplementation(url => url === '/library/old.png' ? oldFetch.promise : Promise.resolve(response(SECOND_PNG)));
    const oldCopy = copyCanvasImageToClipboard('/library/old.png');
    expect(await copyCanvasImageToClipboard('/library/new.png')).toBe(true);
    oldFetch.resolve(response(PNG));
    expect(await oldCopy).toBe(false);
    expect(copyImage).toHaveBeenCalledOnce();
    expect([...copyImage.mock.calls[0][0]]).toEqual([...SECOND_PNG]);
  });

  it('supersedes an older pending copy even if the newest image fetch fails', async () => {
    const oldFetch = deferred();
    fetch.mockImplementation(url => url === '/library/old.png' ? oldFetch.promise : Promise.reject(new Error('latest unavailable')));
    const oldCopy = copyCanvasImageToClipboard('/library/old.png');
    await expect(copyCanvasImageToClipboard('/library/new.png')).rejects.toThrow();
    oldFetch.resolve(response(PNG));
    expect(await oldCopy).toBe(false);
    expect(copyImage).not.toHaveBeenCalled();
  });

  it('releases an older delayed decode and never writes it after a new copy', async () => {
    const oldDecode = deferred();
    fetch.mockImplementation(url => Promise.resolve(url.endsWith('.jpg')
      ? response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg') : response(SECOND_PNG)));
    createImageBitmap.mockReturnValueOnce(oldDecode.promise);
    const oldCopy = copyCanvasImageToClipboard('/library/old.jpg');
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    expect(await copyCanvasImageToClipboard('/library/new.png')).toBe(true);
    oldDecode.resolve(bitmap);
    expect(await oldCopy).toBe(false);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(copyImage).toHaveBeenCalledOnce();
  });

  it('ignores a late older PNG encoding after a newer image was already copied', async () => {
    let finishEncoding;
    fetch.mockImplementation(url => Promise.resolve(url.endsWith('.jpg')
      ? response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg') : response(SECOND_PNG)));
    toBlob.mockImplementation(callback => { finishEncoding = callback; });
    const oldCopy = copyCanvasImageToClipboard('/library/old.jpg');
    await waitFor(() => expect(toBlob).toHaveBeenCalledOnce());
    expect(await copyCanvasImageToClipboard('/library/new.png')).toBe(true);
    finishEncoding(new Blob([PNG], { type: 'image/png' }));
    expect(await oldCopy).toBe(false);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(copyImage).toHaveBeenCalledOnce();
    expect([...copyImage.mock.calls[0][0]]).toEqual([...SECOND_PNG]);
  });

  it('rejects an obsolete browser ClipboardItem image promise before it can replace the latest image', async () => {
    Object.defineProperty(window, 'aifisherDesktop', { configurable: true, value: undefined });
    const oldFetch = deferred();
    fetch.mockImplementation(url => url === '/library/old.png' ? oldFetch.promise : Promise.resolve(response(SECOND_PNG)));
    const oldCopy = copyCanvasImageToClipboard('/library/old.png');
    expect(await copyCanvasImageToClipboard('/library/new.png')).toBe(true);
    oldFetch.resolve(response(PNG));
    expect(await oldCopy).toBe(false);
    expect(browserImages).toHaveLength(1);
    expect([...new Uint8Array(await browserImages[0].arrayBuffer())]).toEqual([...SECOND_PNG]);
    expect(copyImage).not.toHaveBeenCalled();
  });
});

async function mountCanvas(initial = [imageNode], selected = ['image']) {
  let currentCommands;
  let nextId = 0;
  const createId = () => `clone-${++nextId}`;
  function Harness() {
    const [nodes, setNodes] = React.useState(initial);
    const [ids, setSelectedNodeIds] = React.useState(selected);
    currentCommands = useCanvasCommands(React, createId, {
      nodes, viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeIds: ids,
      selectedConnection: null, setNodes, setSelectedNodeIds,
      setContextMenu() {}, deleteNodes() {}, deleteSelectedConnection() {},
      clearSelection() {}, clearSelectionBox() {}, undo() {}, redo() {},
      autoAlignNodes() {}, handleSaveWorkflow() {}, focusOnNodes() {}, groupSelectedNodes() {},
    });
    return <><input aria-label="正文" /><div contentEditable data-testid="rich-text" />
      <output data-testid="nodes">{JSON.stringify(nodes)}</output></>;
  }
  const page = render(<Harness />);
  return { ...page,
    nodes: () => JSON.parse(page.getByTestId('nodes').textContent),
    paste: () => act(() => { currentCommands.handlePaste(); }),
    hasCopiedNodes: () => currentCommands.hasCopiedNodes(),
    copy: (options = {}, target = window) => act(() => {
      fireEvent.keyDown(target, { key: 'c', code: 'KeyC', ctrlKey: true, ...options });
    }),
  };
}

describe('real canvas command integration', () => {
  it('Ctrl+C writes an image while retaining node snapshots and original internal paste connections', async () => {
    const original = { ...imageNode, parentIds: ['parent'], prompt: '保留节点提示词' };
    const page = await mountCanvas([
      { id: 'parent', type: 'Text', x: 0, y: 0 }, original,
      { id: 'child', type: 'Video', x: 100, y: 100, parentIds: ['image'] },
    ]);
    page.copy();
    await waitFor(() => expect(copyImage).toHaveBeenCalledOnce());
    expect(page.hasCopiedNodes()).toBe(true);
    page.paste();
    const nodes = page.nodes();
    expect(nodes).toHaveLength(4);
    expect(nodes.find(node => node.id === 'clone-1')).toMatchObject({
      type: 'Image', resultUrl: original.resultUrl, prompt: original.prompt,
      x: 60, y: 70, parentIds: ['parent'],
    });
    expect(nodes.find(node => node.id === 'child').parentIds).toEqual(['image', 'clone-1']);
    expect(nodes.find(node => node.id === 'image')).toEqual(original);
    expect(copyImage).toHaveBeenCalledOnce();
  });

  it('ignores text editors, IME, legacy 229, and repeated copy keydown', async () => {
    const page = await mountCanvas();
    const input = page.getByRole('textbox', { name: '正文' });
    page.copy({}, input);
    page.copy({}, page.getByTestId('rich-text'));
    page.copy({ isComposing: true }); page.copy({ keyCode: 229 }); page.copy({ repeat: true });
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(copyImage).not.toHaveBeenCalled();
    expect(page.hasCopiedNodes()).toBe(false);
  });

  it.each(['loading', 'queued'])('never starts image copy or node cloning for a %s node', async status => {
    const page = await mountCanvas([{ ...imageNode, status }]);
    page.copy(); page.paste();
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(copyImage).not.toHaveBeenCalled();
    expect(page.nodes()).toHaveLength(1);
  });

  it('keeps multi-selection internal paste without choosing an arbitrary image for system clipboard', async () => {
    const page = await mountCanvas([imageNode, { id: 'text', type: 'Text', x: 50, y: 50 }], ['image', 'text']);
    page.copy(); page.paste();
    await act(async () => {});
    expect(page.nodes()).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
    expect(copyImage).not.toHaveBeenCalled();
  });

  it('retains a usable internal node copy after the image fetch fails', async () => {
    fetch.mockRejectedValueOnce(new Error('missing image'));
    const page = await mountCanvas();
    page.copy();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await act(async () => {});
    page.paste();
    expect(page.nodes()).toHaveLength(2);
    expect(page.nodes()[1]).toMatchObject({ resultUrl: imageNode.resultUrl, type: 'Image' });
    expect(copyImage).not.toHaveBeenCalled();
  });
});
