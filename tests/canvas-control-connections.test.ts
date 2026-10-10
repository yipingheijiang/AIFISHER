// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasControlExecutor } from '../src/stable/agent/canvasControlExecutor';
import { connectNewCanvasNode, type CanvasNode, type NodeRuntime } from '../src/stable/nodes/canvasNodeOperations';
import { chooseConnectionMode } from '../src/stable/nodes/canvasNodeRules';
import { createWorkflowCanvasNodes } from '../src/stable/local/workflowCanvasNodes';
import type { WorkflowCanvasClient } from '../src/stable/local/workflowManagerClient';
import { validCanvasControl, type CanvasControl } from '../src/shared/canvasControlProtocol.js';
import { createCanvasControlBridge } from '../server/agent/codex/canvasControlBridge.js';

const projectId = 'connection-project';
const pictureIds = Array.from({ length: 8 }, (_, index) => `picture-${index + 1}`);
function fixture() {
  const startCanvasRun = vi.fn();
  window.__FISHERAI_WORKFLOW_NODES__ = createWorkflowCanvasNodes({ startCanvasRun } as unknown as WorkflowCanvasClient);
  const director: CanvasNode = {
    id: 'director', type: 'ComfyUI', kind: 'workflow', projectId, x: 100, y: 0,
    inputPorts: [
      ...pictureIds.map((_, index) => ({ id: `image-${index}`, label: `图${index + 1}`, mediaKind: 'image', multiple: false, portIndex: index })),
      { id: 'video', label: '参考视频', mediaKind: 'video', multiple: false, portIndex: 8 },
    ],
    parameterSchema: [{ key: 'prompt', label: '提示词', control: { kind: 'textarea' } }],
    parameterValues: { prompt: '' },
    parentIds: [...new Array(9).fill(''), 'script'], sourcePortIndices: new Array(10).fill(0),
  };
  let state = { nodes: [
    ...pictureIds.map(id => ({ id, type: 'Upload Image', projectId, x: 0, y: 0, parentIds: [] })),
    { id: 'script', type: 'Text', projectId, x: 0, y: 0, prompt: 'Picture 1 through Picture 8', parentIds: [] },
    director,
  ] as CanvasNode[], groups: [] };
  const before = structuredClone(state);
  const catalog = { image: [], video: [], audio: [], text: [] };
  const nodeRuntime: NodeRuntime = {
    createId: () => crypto.randomUUID(), imageModels: [], videoModels: [], audioModels: [], textModels: [], templates: [],
    mediaType: type => type.includes('Image') ? 'image' : 'text',
    canConnect: (source, target, nodes, port) => chooseConnectionMode(source, target, nodes, port, catalog),
    validateConnection: () => true,
  };
  const commit = vi.fn((_previous, next) => { state = next; });
  const execute = createCanvasControlExecutor(() => ({
    projectId, snapshot: () => state, create: () => { throw Error('Creation is not part of reference binding'); }, commit,
    connect: (nodes, sourceId, targetId, sourcePort) => connectNewCanvasNode(nodes, sourceId, targetId, nodeRuntime, sourcePort),
  }));
  const request = (command: CanvasControl) => ({ requestId: crypto.randomUUID(), projectId, sessionId: 'session', expiresAt: Date.now() + 30000, command });
  const read = () => execute(request({ action: 'read' }));
  const edit = (operations: unknown[]) => execute(request({ action: 'edit', revision: read().revision!, operations } as CanvasControl));
  const connect = (id: string) => ({ kind: 'connect', sourceId: id, targetId: 'director' });
  return { execute, request, read, edit, connect, commit, startCanvasRun, before, state: () => state };
}
afterEach(() => { delete window.__FISHERAI_WORKFLOW_NODES__; vi.restoreAllMocks(); });

describe('Codex reference connection calling convention', () => {
  it('binds eight pictures in order through the native workflow allocator, keeps text/video slots and supports undo', () => {
    const f = fixture();
    const receipt = f.edit(pictureIds.map(f.connect));
    expect(receipt.ok).toBe(true);
    const director = f.read().nodes!.find(node => node.id === 'director')!;
    expect(director.parentIds).toEqual([...pictureIds, '', 'script']);
    expect(director.sourcePortIndices).toEqual(new Array(10).fill(0));
    expect(f.commit).toHaveBeenCalledTimes(1);
    const undone = f.execute(f.request({ action: 'undo', revision: receipt.revision!, operationId: receipt.operationId! }));
    expect(undone.ok).toBe(true);
    expect(f.state()).toEqual(f.before);
    expect(f.startCanvasRun).not.toHaveBeenCalled();
  });

  it('rejects targetPort at the Codex bridge and accepts the corrected ordered batch with a confirmed executor receipt', async () => {
    const f = fixture();
    const bridge = createCanvasControlBridge();
    const emit = vi.fn();
    const run = { canvasControl: true, projectId, sessionId: 'session', emit };
    const revision = f.read().revision!;
    await expect(bridge.dispatch(run, { action: 'edit', revision, operations: [{ ...f.connect(pictureIds[0]), sourcePort: 0, targetPort: 0 }] })).resolves.toEqual({ ok: false, code: 'INVALID' });
    expect(emit).not.toHaveBeenCalled();
    const pending = bridge.dispatch(run, { action: 'edit', revision, operations: pictureIds.map(f.connect) });
    const action = emit.mock.calls[0][1];
    bridge.complete(action.requestId, { projectId, sessionId: 'session', result: f.execute(action) });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(f.read().nodes!.find(node => node.id === 'director')!.parentIds).toEqual([...pictureIds, '', 'script']);
  });

  it('continues to accept numeric sourcePort zero for ordinary images', () => {
    const f = fixture();
    expect(f.edit([{ ...f.connect(pictureIds[0]), sourcePort: 0 }]).ok).toBe(true);
    expect(f.state().nodes.find(node => node.id === 'director')!.parentIds![0]).toBe(pictureIds[0]);
  });

  it('uses sourcePort as the source workflow output index, not the target image slot', () => {
    const f = fixture();
    f.state().nodes.push({ id: 'source-workflow', type: 'ComfyUI', kind: 'workflow', projectId, x: 0, y: 0, parentIds: [],
      outputPorts: [{ id: 'video', mediaKind: 'video', primary: true }, { id: 'image', mediaKind: 'image' }] });
    expect(f.edit([{ ...f.connect('source-workflow'), sourcePort: 1 }]).ok).toBe(true);
    const director = f.state().nodes.find(node => node.id === 'director')!;
    expect(director.parentIds![0]).toBe('source-workflow');
    expect(director.parentIds![1]).toBe('');
    expect(director.sourcePortIndices![0]).toBe(1);
  });

  it.each([{ targetPort: 0 }, { sourcePort: '0' }, { sourcePort: null }, { sourcePort: -1 }])('refuses invalid connect parameters without partially applying earlier operations: %j', extra => {
    const f = fixture();
    const operations = [f.connect(pictureIds[0]), { ...f.connect(pictureIds[1]), ...extra }];
    expect(validCanvasControl({ action: 'edit', revision: f.read().revision, operations })).toBe(false);
    expect(f.edit(operations)).toEqual({ ok: false, code: 'INVALID' });
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.state()).toEqual(f.before);
  });

  it('leaves occupied slots intact when a reference batch exceeds the available compatible inputs', () => {
    const f = fixture();
    f.state().nodes.find(node => node.id === 'director')!.parentIds![0] = pictureIds[0];
    const before = structuredClone(f.state());
    expect(f.edit(pictureIds.map(f.connect))).toEqual({ ok: false, code: 'INVALID' });
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.state()).toEqual(before);
  });

  it('uses targetPort only for disconnect and permits deliberate ordered rebind in one atomic edit', () => {
    const f = fixture();
    expect(f.edit(pictureIds.map(f.connect)).ok).toBe(true);
    const result = f.edit([
      { kind: 'disconnect', sourceId: pictureIds[1], targetId: 'director', targetPort: 1 },
      { kind: 'disconnect', sourceId: pictureIds[0], targetId: 'director', targetPort: 0 },
      f.connect(pictureIds[1]), f.connect(pictureIds[0]),
    ]);
    expect(result.ok).toBe(true);
    expect(f.state().nodes.find(node => node.id === 'director')!.parentIds).toEqual([pictureIds[1], pictureIds[0], ...pictureIds.slice(2), '', 'script']);
    expect(f.startCanvasRun).not.toHaveBeenCalled();
  });
});
