import { describe, it, expect } from 'vitest';
import { createImageAngleDraft, panoramaPrompt } from '../src/stable/media/imageAngleDraft';
import { chooseConnectionMode } from '../src/stable/nodes/canvasNodeRules';
import { connectCanvasNodes } from '../src/stable/canvas/canvasConnections';

describe('local image tool drafts', () => {
  const catalog = { image: [], video: [], audio: [], text: [] };
  const runtime = {
    create: (type, point, projectId) => ({ id: 'draft', type, ...point, projectId, imageModel: 'paid-default', model: 'paid-default', parentIds: [] }),
    configure: (nodes, id, patch) => nodes.map(node => node.id === id ? { ...node, ...patch } : node),
    connect: (nodes, sourceId, targetId) => {
      const source = nodes.find(node => node.id === sourceId), target = nodes.find(node => node.id === targetId);
      expect(chooseConnectionMode(source, target, nodes, undefined, catalog)).toBe('default');
      return connectCanvasNodes(nodes, { parentId: sourceId, childId: targetId });
    },
    width: () => 240,
  };
  const source = { id: 'source', type: 'Upload Image', resultUrl: '/library/local.png', x: 0, y: 0, aspectRatio: '4:3', parentIds: [] };
  it('keeps the local panorama reference without choosing or submitting a model', () => {
    const result = createImageAngleDraft([source], source.id, null, 'project', runtime);
    const draft = result.nodes.find(node => node.id === result.id);
    expect(draft.imageModel).toBe(''); expect(draft.model).toBe('');
    expect(draft.parentIds).toEqual([source.id]); expect(draft.prompt).toBe(panoramaPrompt);
    expect(draft.aspectRatio).toBe('2:1'); expect(result.nodes[0]).toBe(source);
  });
  it('retains angle settings and rejects unfinished uploads before creating a draft', () => {
    const result = createImageAngleDraft([source], source.id, { horizontal: 90, vertical: 0, distance: 1 }, 'project', runtime);
    expect(result.nodes[1].imageAngle).toBeTruthy(); expect(result.nodes[1].imageModel).toBe('');
    expect(result.nodes[1].aspectRatio).toBe('4:3');
    expect(() => createImageAngleDraft([{ ...source, uploadPending: true }], source.id, null, 'project', runtime)).toThrow('原图尚未准备好');
  });
});
