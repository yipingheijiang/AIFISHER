// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Mention from '@tiptap/extension-mention';
import { CanvasPromptEditor } from '../src/stable/prompt/canvasPromptEditor';

// jsdom does not calculate Range geometry, which ProseMirror uses when focusing.
if (!Range.prototype.getClientRects)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
  Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountEditor(overrides = {}) {
  let editor;
  const changes = vi.fn();
  const submits = vi.fn();
  const selections = vi.fn();
  const menus = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      text: [], video: [], audio: [],
      image: [{ name: '测试预设', items: [{ title: '蓝鱼', prompt: 'a blue fish' }] }],
    }),
  })));
  const vendor = {
    StarterKit, Placeholder, Mention,
    useEditor(options, dependencies) {
      const current = useEditor(options, dependencies);
      React.useLayoutEffect(() => { editor = current; }, [current]);
      return current;
    },
    EditorContent,
    nodeView: () => () => ({ dom: document.createElement('span') }),
    PromptTagView: null, MentionView: null,
    PresetList: 'preset', MentionList: 'mention',
    ui: {
      createRenderer(component, initial) {
        let props = initial;
        const menu = { component, get items() { return props.items || []; } };
        menus.push(menu);
        return {
          element: document.createElement('div'),
          ref: {
            onKeyDown({ event }) {
              if (event.key !== 'Enter' || !props.items?.length) return false;
              const item = props.items[0];
              selections(component, item);
              props.command(component === 'preset'
                ? { label: item.title, prompt: item.prompt }
                : { id: item.id, label: item.label, assetType: item.type, url: item.url });
              return true;
            },
          },
          updateProps(next) { props = next; },
          destroy() {},
        };
      },
      createPopup() {
        return { state: { isShown: true }, setProps() {}, hide() {}, destroy() {} };
      },
    },
  };
  const base = {
    value: '画一条鱼', onChange: changes, onSubmit: submits,
    connectedAssets: [{ id: 'fish', type: 'image', title: '鱼', url: '/library/fish.png' }],
    ...overrides,
  };
  function Harness(props) {
    return CanvasPromptEditor(React, props, vendor);
  }
  const result = render(<Harness {...base} />);
  await waitFor(() => expect(editor).toBeTruthy());
  await act(async () => { editor.commands.focus('end'); });
  return {
    ...result, get editor() { return editor; },
    changes, submits, selections, menus,
    rerenderProps(next) { result.rerender(<Harness {...base} {...next} />); },
    async content(value, emitUpdate = true) {
      await act(async () => {
        editor.commands.setContent(value, { emitUpdate });
        editor.commands.focus('end');
      });
    },
    key(options = {}) {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...options,
      });
      act(() => { editor.view.dom.dispatchEvent(event); });
      return event;
    },
  };
}

describe('generation prompt keyboard with the real Tiptap editor', () => {
  it('submits Ctrl+Enter without a newline and synchronizes the current document first', async () => {
    const page = await mountEditor();
    await page.content('<p>最新提示词</p>', false);
    page.changes.mockClear();
    const event = page.key({ ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(page.changes).toHaveBeenLastCalledWith('最新提示词');
    expect(page.submits).toHaveBeenCalledOnce();
    expect(page.changes.mock.invocationCallOrder[0]).toBeLessThan(page.submits.mock.invocationCallOrder[0]);
    expect(page.editor.getJSON().content).toHaveLength(1);
    expect(page.editor.getText()).toBe('最新提示词');
  });

  it('keeps native Enter paragraphs, Shift+Enter hard breaks, and ordinary editors unchanged', async () => {
    const page = await mountEditor();
    page.key();
    expect(page.editor.getJSON().content).toHaveLength(2);
    expect(page.changes).toHaveBeenLastCalledWith('画一条鱼\n');
    expect(page.submits).not.toHaveBeenCalled();
    await page.content('<p>画一条鱼</p>');
    page.key({ shiftKey: true });
    expect(page.submits).not.toHaveBeenCalled();
    expect(page.editor.getJSON().content[0].content.at(-1).type).toBe('hardBreak');
    expect(page.changes).toHaveBeenLastCalledWith('画一条鱼\n');
    page.rerenderProps({ onSubmit: undefined });
    page.key();
    expect(page.editor.getJSON().content).toHaveLength(2);
    page.key({ ctrlKey: true });
    expect(page.submits).not.toHaveBeenCalled();
  });

  it('submits only the exact Ctrl+Enter chord, without Shift, Alt, or Meta', async () => {
    const page = await mountEditor();
    for (const modifiers of [
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { metaKey: true },
    ]) page.key(modifiers);
    expect(page.submits).not.toHaveBeenCalled();
    page.key({ ctrlKey: true });
    expect(page.submits).toHaveBeenCalledOnce();
  });

  it('ignores IME Enter, the composing view, legacy key 229, and long-press repeats', async () => {
    const page = await mountEditor();
    // Standalone flags prove the submit guard only. Without compositionstart,
    // ProseMirror's native keymap can still treat a synthetic Enter as a newline.
    page.key({ ctrlKey: true, isComposing: true });
    page.key({ ctrlKey: true, keyCode: 229 });
    Object.defineProperty(page.editor.view, 'composing', { configurable: true, value: true });
    page.key({ ctrlKey: true });
    Object.defineProperty(page.editor.view, 'composing', { configurable: true, value: false });
    const beforeRepeat = page.editor.getJSON();
    const repeated = page.key({ ctrlKey: true, repeat: true });
    expect(repeated.defaultPrevented).toBe(true);
    expect(page.submits).not.toHaveBeenCalled();
    expect(page.editor.getJSON()).toEqual(beforeRepeat);
    page.key({ ctrlKey: true });
    expect(page.submits).toHaveBeenCalledOnce();
  });

  it('preserves the document throughout the native IME composition lifecycle', async () => {
    const page = await mountEditor({ value: '蓝鱼\n第二行' });
    const before = page.editor.getJSON();
    act(() => { fireEvent.compositionStart(page.editor.view.dom); });
    expect(page.editor.view.composing).toBe(true);
    const confirming = page.key({ keyCode: 229, isComposing: true });
    page.key({ ctrlKey: true, keyCode: 229, isComposing: true });
    expect(confirming.defaultPrevented).toBe(false);
    expect(page.editor.getJSON()).toEqual(before);
    expect(page.submits).not.toHaveBeenCalled();
    act(() => { fireEvent.compositionEnd(page.editor.view.dom); });
    expect(page.editor.view.composing).toBe(false);
    expect(page.editor.getJSON()).toEqual(before);
    expect(page.submits).not.toHaveBeenCalled();
  });

  it('does not submit in read-only mode and uses the latest optional callback', async () => {
    const page = await mountEditor({ disableDirectEdit: true });
    page.key({ ctrlKey: true });
    expect(page.submits).not.toHaveBeenCalled();
    const replacement = vi.fn();
    page.rerenderProps({ disableDirectEdit: false, onSubmit: replacement });
    page.key({ ctrlKey: true });
    expect(page.submits).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'Enter', modifiers: {} },
    { label: 'Ctrl+Enter', modifiers: { ctrlKey: true } },
  ])('confirms an active @ mention with $label before a later Ctrl+Enter can submit', async ({ modifiers }) => {
    const page = await mountEditor();
    await page.content('<p>@</p>');
    await waitFor(() => expect(page.menus.at(-1)?.items).toHaveLength(1));
    page.key({ ctrlKey: true, repeat: true });
    expect(page.selections).not.toHaveBeenCalled();
    expect(page.submits).not.toHaveBeenCalled();
    page.key(modifiers);
    expect(page.selections).toHaveBeenCalledOnce();
    expect(page.submits).not.toHaveBeenCalled();
    expect(page.editor.getJSON().content[0].content[0].type).toBe('mention');
    page.key({ ctrlKey: true });
    expect(page.submits).toHaveBeenCalledOnce();
    expect(page.changes).toHaveBeenLastCalledWith('{image1}');
  });

  it.each([
    { label: 'Enter', modifiers: {} },
    { label: 'Ctrl+Enter', modifiers: { ctrlKey: true } },
  ])('confirms a loaded prompt preset with $label without submitting generation', async ({ modifiers }) => {
    const page = await mountEditor();
    await page.content('<p>\\</p>');
    await waitFor(() => expect(page.menus.at(-1)?.items).toHaveLength(1));
    page.key(modifiers);
    expect(page.selections).toHaveBeenCalledWith('preset', expect.objectContaining({ title: '蓝鱼' }));
    expect(page.submits).not.toHaveBeenCalled();
    expect(page.changes).toHaveBeenLastCalledWith('[[蓝鱼|a blue fish]]');
    page.key({ ctrlKey: true });
    expect(page.submits).toHaveBeenCalledOnce();
  });

  it('never submits from an empty candidate menu; Shift+Enter still inserts a hard break', async () => {
    const page = await mountEditor({ connectedAssets: [] });
    await page.content('<p>@</p>');
    expect(page.menus.at(-1)?.items).toHaveLength(0);
    page.key();
    page.key({ ctrlKey: true });
    page.key({ ctrlKey: true, repeat: true });
    expect(page.submits).not.toHaveBeenCalled();
    expect(page.editor.getText()).toBe('@');
    page.key({ shiftKey: true });
    expect(page.editor.getJSON().content[0].content.at(-1).type).toBe('hardBreak');
    expect(page.submits).not.toHaveBeenCalled();
  });

  it('allows Ctrl+Enter to submit after Escape has dismissed a suggestion', async () => {
    const page = await mountEditor();
    await page.content('<p>@</p>');
    await waitFor(() => expect(page.menus.at(-1)?.items).toHaveLength(1));
    act(() => { fireEvent.keyDown(page.editor.view.dom, { key: 'Escape' }); });
    page.key({ ctrlKey: true });
    expect(page.selections).not.toHaveBeenCalled();
    expect(page.submits).toHaveBeenCalledOnce();
  });
});
