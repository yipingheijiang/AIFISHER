// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createWorkflowCanvasNodes, type WorkflowCanvasNodeRecord } from '../src/stable/local/workflowCanvasNodes';
import { useWorkflowNodeSession } from '../src/stable/local/workflowNodeSession';
import { attachWorkflowNodeEvents } from '../src/stable/nodes/canvasNodeState';
import type { WorkflowCanvasClient, WorkflowRun } from '../src/stable/local/workflowManagerClient';
import type { CanvasNode } from '../src/stable/nodes/canvasNodeOperations';

const projectId = 'video-output-project';
const runId = 'existing-cloud-run';
const url = `/library/media/${projectId}/videos/existing-video.mp4`;
function workflow(): WorkflowCanvasNodeRecord {
  return {
    id: 'workflow', type: 'ComfyUI', kind: 'workflow', comfyMode: 'fisherai-workflow',
    projectId, x: 100, y: 150, width: 600, height: 520, title: 'Cloud video', subtitle: 'RunningHub',
    executionTarget: 'cloud', canvasNodeHash: 'hash',
    workflowRef: { definitionId: 'definition', verificationStatus: 'draft', deploymentId: 'deployment', bindingSetId: 'bindings' } as WorkflowCanvasNodeRecord['workflowRef'],
    inputPorts: [], outputPorts: [], parameterSchema: [], parameterValues: {}, parentIds: [], sourcePortIndices: [],
    status: 'loading', workflowOutputs: [],
    executionState: { runId, status: 'observing-paused', phase: 'observation-paused' },
  };
}
const success: WorkflowRun = {
  runId, projectId, runner: 'runninghub-webapp', status: 'success', phase: 'completed',
  receipt: { receiptHash: 'receipt', succeededAt: '2026-10-09T08:30:00Z', outputs: [
    { portId: 'draft_output_1', nodeId: 'output', outputKey: 'videos', outputIndex: 0,
      mediaKind: 'video', primary: true, assetId: 'video-asset', url, bytes: 512 },
  ] },
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__FISHERAI_WORKFLOW_NODES__; });

describe('cloud workflow video receipt to canvas', () => {
  it('reconnects a mounted paused cloud run and publishes its existing video without submitting another task', async () => {
    const startCanvasRun = vi.fn();
    let continued = false;
    const continueObservation = vi.fn(async () => { continued = true; return success; });
    const getRun = vi.fn(async () => continued ? success : { ...success, status: 'loading', phase: 'observation-paused', receipt: undefined } as WorkflowRun);
    const adapter = createWorkflowCanvasNodes({ startCanvasRun, continueObservation, getRun } as unknown as WorkflowCanvasClient);
    window.__FISHERAI_WORKFLOW_NODES__ = adapter;
    let nodes: CanvasNode[] = [workflow() as CanvasNode];
    let selected: string[] = [];
    let disposeEvents: () => void;
    function Harness() {
      const [, refresh] = React.useReducer(n => n + 1, 0);
      React.useEffect(() => {
        disposeEvents = attachWorkflowNodeEvents({
          getNodes: () => nodes,
          setNodes: update => { nodes = typeof update === 'function' ? update(nodes) : update; refresh(); },
          setSelected: update => { selected = typeof update === 'function' ? update(selected) : update; },
        }, { getWidth: () => 600, createId: () => crypto.randomUUID() });
        return disposeEvents;
      }, []);
      useWorkflowNodeSession(React, adapter, {
        node: nodes[0] as unknown as WorkflowCanvasNodeRecord, connectedNodes: nodes, projectId,
      }, (id, patch) => { nodes = nodes.map(n => n.id === id ? { ...n, ...patch } : n); refresh(); }, () => {});
      return <div>{nodes.filter(n => n.type === 'Upload Video').map(n => <video key={n.id} src={n.resultUrl} />)}</div>;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe(url));
    expect(continueObservation).toHaveBeenCalledOnce();
    expect(continueObservation).toHaveBeenCalledWith(runId);
    expect(startCanvasRun).not.toHaveBeenCalled();
    expect(nodes[0].status).toBe('success');
    const video = nodes.find(n => n.type === 'Upload Video')!;
    expect(video.parentIds).toEqual(['workflow']);
    expect(video.workflowSourceRunId).toBe(runId);
    expect(video.projectId).toBe(projectId);
    await act(async () => { await adapter.resume(nodes[0] as unknown as WorkflowCanvasNodeRecord, patch => { nodes[0] = { ...nodes[0], ...patch }; }); });
    expect(nodes.filter(n => n.type === 'Upload Video')).toHaveLength(1);
  });
  it('publishes a backend-completed run from a stale paused view without trying to restart observation', async () => {
    const source = workflow();
    const continueObservation = vi.fn(async () => { throw Error('409: not paused'); });
    const getRun = vi.fn(async () => success);
    const adapter = createWorkflowCanvasNodes({ continueObservation, getRun } as unknown as WorkflowCanvasClient);
    const patch = vi.fn();
    const output = vi.fn();
    window.addEventListener('fisherai:add-workflow-output-nodes', output);
    try {
      await adapter.resume(source, patch, undefined, true);
      expect(continueObservation).not.toHaveBeenCalled();
      expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success', resultUrl: url }));
      expect(output).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('fisherai:add-workflow-output-nodes', output); }
  });
  it('reads the same receipt after a competing observer wins the continuation race', async () => {
    const paused = { ...success, status: 'loading', phase: 'observation-paused', receipt: undefined } as WorkflowRun;
    const getRun = vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(success);
    const continueObservation = vi.fn(async () => { throw Error('409: resumed elsewhere'); });
    const adapter = createWorkflowCanvasNodes({ continueObservation, getRun } as unknown as WorkflowCanvasClient);
    const patch = vi.fn();
    await expect(adapter.resume(workflow(), patch, undefined, true)).resolves.toBe(success);
    expect(continueObservation).toHaveBeenCalledOnce();
    expect(getRun.mock.calls).toEqual([[runId], [runId]]);
    expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success', resultUrl: url }));
  });
  it('does not publish into an expired canvas when the original receipt arrives late', async () => {
    let resolve!: (run: WorkflowRun) => void;
    const getRun = vi.fn(() => new Promise<WorkflowRun>(done => { resolve = done; }));
    const continueObservation = vi.fn();
    const adapter = createWorkflowCanvasNodes({ continueObservation, getRun } as unknown as WorkflowCanvasClient);
    let current = true;
    const patch = vi.fn();
    const pending = adapter.resume(workflow(), patch, { isCurrent: () => current }, true);
    current = false;
    resolve(success);
    await expect(pending).rejects.toThrow('画布已变化');
    expect(patch).not.toHaveBeenCalled();
    expect(continueObservation).not.toHaveBeenCalled();
  });
  it('leaves paused local work under manual control and resumes paused cloud work only when visible', async () => {
    const resume = vi.fn(async () => null);
    const adapter = {
      resume, reconcileNode: vi.fn(), applySeedAdvancements: (_: unknown) => ({}),
    } as unknown as ReturnType<typeof createWorkflowCanvasNodes>;
    const source = workflow();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    function Harness({ node }: { node: WorkflowCanvasNodeRecord }) {
      useWorkflowNodeSession(React, adapter, { node, connectedNodes: [], projectId }, () => {}, () => {});
      return null;
    }
    const view = render(<Harness node={{ ...source, executionTarget: 'local' }} />);
    await act(async () => {});
    expect(resume).not.toHaveBeenCalled();
    view.rerender(<Harness node={source} />);
    await act(async () => {});
    expect(resume).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(resume).toHaveBeenCalledOnce();
  });
});
