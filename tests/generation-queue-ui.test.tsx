// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createCanvasGeneration, observeWithin } from '../src/stable/generation/canvasGeneration';
import { mountGenerationRecovery } from '../src/stable/generation/generationRecovery';
import { GenerationQueueStatus } from '../src/stable/generation/GenerationQueueStatus';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (data, ok = true) => ({ ok, json: async () => data });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('queued canvas generation', () => {
  it('submits exactly once despite full concurrency, keeps old media, and ignores obsolete results', async () => {
    let nodes = [{ id: 'queue-ui-once', type: 'Image', status: 'idle', prompt: 'fish', imageModel: 'test', x: 0, y: 0, resultUrl: '/old.png' }];
    let resolve;
    const runtime = { image: vi.fn(() => new Promise(done => { resolve = done; })), concurrency: vi.fn(async () => ({ blocked: true })), now: Date.now,
      inspectImage: vi.fn(async () => ({})) };
    const controller = createCanvasGeneration({ getNodes: () => nodes, getProjectId: () => 'a', updateNode: (id, patch) => { nodes = nodes.map(node => node.id === id ? { ...node, ...patch } : node); } },
      { imageModels: [{ name: 'test' }], videoModels: [], audioModels: [], textModels: [] }, runtime);
    try {
      const running = controller.handleGenerate(nodes[0].id);
      await flush();
      expect(nodes[0]).toMatchObject({ status: 'queued', projectId: 'a', resultUrl: '/old.png' });
      expect(runtime.image).toHaveBeenCalledTimes(1);
      expect(runtime.concurrency).not.toHaveBeenCalled();
      await controller.handleGenerate(nodes[0].id);
      expect(runtime.image).toHaveBeenCalledTimes(1);
      nodes = [{ ...nodes[0], status: 'idle', generationAttemptId: 'new-attempt', prompt: 'new input' }];
      resolve('/late.png');
      await running;
      expect(nodes[0]).toMatchObject({ prompt: 'new input', resultUrl: '/old.png' });
    } finally { controller.dispose(); }
  });

  it('excludes arbitrarily long queue waiting from the observation budget', async () => {
    vi.useFakeTimers();
    let queued = true, resolve;
    const waiting = observeWithin(new Promise(done => { resolve = done; }), 1000, () => queued);
    await vi.advanceTimersByTimeAsync(60_000);
    queued = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(999);
    resolve('ready');
    await expect(waiting).resolves.toBe('ready');
    const interrupted = observeWithin(new Promise(() => {}), 1000);
    const assertion = expect(interrupted).rejects.toMatchObject({ code: 'GENERATION_OBSERVATION_INTERRUPTED' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('recovers queue position and admission with the same attempt and never resubmits', async () => {
    let nodes = [{ id: 'recover-queue', type: 'Image', projectId: 'p', status: 'queued', generationAttemptId: 'attempt', generationStartTime: 100 }];
    let data = { status: 'pending', phase: 'queued', queuePosition: 2, queuedAt: '2026-10-09T00:00:00Z', attemptId: 'attempt' };
    const fetchImpl = vi.fn(async () => response(data));
    const updates = vi.fn((id, patch) => { nodes = nodes.map(node => node.id === id ? { ...node, ...patch } : node); });
    const session = mountGenerationRecovery({ getNodes: () => nodes, updateNode: updates }, { fetchImpl, intervalMs: 60_000 });
    try {
      await flush();
      expect(nodes[0]).toMatchObject({ status: 'queued', generationQueuePosition: 2, generationStartTime: 100, generationAttemptId: 'attempt' });
      session.scan(); await flush(); expect(updates).toHaveBeenCalledTimes(1);
      data = { status: 'pending', phase: 'loading', startedAt: '2026-10-09T00:01:00Z', attemptId: 'attempt' };
      session.scan(); await flush();
      expect(nodes[0]).toMatchObject({ status: 'loading', generationStartTime: 100, generationExecutionStartedAt: Date.parse(data.startedAt) });
      expect(nodes[0].generationQueuePosition).toBeUndefined();
      data = { status: 'success', type: 'image', resultUrl: '/new.png', attemptId: 'old-attempt' };
      session.scan(); await flush(); expect(nodes[0].status).toBe('loading');
      data = { status: 'failed', code: 'GENERATION_NOT_SUBMITTED', error: '服务已重启，未提交生成', attemptId: 'attempt' };
      session.scan(); await flush();
      expect(nodes[0]).toMatchObject({ status: 'error', generationDiagnosticCode: 'GENERATION_NOT_SUBMITTED' });
      expect(nodes[0].generationAttemptId).toBeUndefined();
      expect(fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    } finally { session.dispose(); }
  });

  it('binds queue cancellation and does not mark an admitted or newer attempt cancelled', async () => {
    let resolve;
    const fetchMock = vi.fn(() => new Promise(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn(), node = { id: 'cancel', projectId: 'p', status: 'queued', generationAttemptId: 'a', generationQueuePosition: 1 };
    const ui = render(<GenerationQueueStatus node={node} onUpdate={onUpdate} />);
    fireEvent.click(ui.getByRole('button', { name: '取消排队' }));
    fireEvent.click(ui.getByRole('button', { name: '取消排队' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ projectId: 'p', attemptId: 'a', onlyQueued: true });
    resolve(response({ code: 'GENERATION_NOT_QUEUED' }, false));
    await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('已开始'));
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: '取消排队' }));
    ui.rerender(<GenerationQueueStatus node={{ ...node, generationAttemptId: 'b' }} onUpdate={onUpdate} />);
    resolve(response({ status: 'cancelled', remoteMayContinue: false }));
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('ignores cancellation responses after the owning composer is unmounted', async () => {
    let resolve;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
    const onUpdate = vi.fn();
    const ui = render(<GenerationQueueStatus node={{ id: 'old-node', projectId: 'old-project', status: 'queued', generationAttemptId: 'old-attempt' }} onUpdate={onUpdate} />);
    fireEvent.click(ui.getByRole('button', { name: '取消排队' }));
    ui.unmount();
    resolve(response({ status: 'cancelled', remoteMayContinue: false }));
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
