// @vitest-environment jsdom
import * as React from 'react';
import { writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasEdges, type EdgeNode } from '../src/stable/canvas/canvasEdges';
import * as edgeGeometry from '../src/stable/canvas/canvasEdgeGeometry';

const geometry = {
  getWidth: () => 100,
  getHeight: () => 100,
  getPortX: (node: EdgeNode, side: 'left' | 'right', width: number) =>
    node.x + (side === 'right' ? width : 0),
  getPortY: (node: EdgeNode, _side: 'left' | 'right', index: number) => node.y + 50 + index * 4,
};
function longEdges(count: number) {
  return Array.from({ length: count }, (_, index) => [
    { id: `source-${index}`, x: -1200, y: index * 12 + 40 },
    { id: `target-${index}`, x: 1800, y: index * 14 + 80, parentIds: [`source-${index}`] },
  ]).flat();
}
function Harness({
  nodes = longEdges(12),
  selectedNodeIds = nodes.map((node) => node.id),
  viewport = { x: 0, y: 0, zoom: 1 },
  onEdgeClick = vi.fn(),
  onEdgeDoubleClick = vi.fn(),
  onRender = vi.fn(),
}: {
  nodes?: EdgeNode[];
  selectedNodeIds?: string[];
  viewport?: { x: number; y: number; zoom: number };
  onEdgeClick?: ReturnType<typeof vi.fn>;
  onEdgeDoubleClick?: ReturnType<typeof vi.fn>;
  onRender?: ReturnType<typeof vi.fn>;
}) {
  return React.createElement(
    React.Profiler,
    { id: 'edge-layer', onRender },
    React.createElement(
      'svg',
      { width: 1000, height: 700 },
      CanvasEdges(
        React,
        {
          nodes,
          selectedNodeIds,
          viewport,
          viewportSize: { width: 1000, height: 700 },
          onEdgeClick,
          onEdgeDoubleClick,
        },
        geometry,
      ),
    ),
  );
}

let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function advanceFrames(count: number, start = 0) {
  for (let index = 1; index <= count; index++) {
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(start + index * (1000 / 60)));
    });
  }
}

describe('canvas edge flow', () => {
  it('animates twelve long crossing edges without React commits or curve resampling per frame', async () => {
    const edgeCount = Number(process.env.AIFISHER_EDGE_FIXTURE_COUNT || 12);
    const commits = vi.fn();
    const sampling = vi.spyOn(edgeGeometry, 'edgeFlowSegments');
    const { container } = render(
      React.createElement(Harness, { nodes: longEdges(edgeCount), onRender: commits }),
    );
    expect(container.querySelectorAll('.edge-flow-segments')).toHaveLength(edgeCount);
    const initialCommits = commits.mock.calls.length;
    const initialSampling = sampling.mock.calls.length;
    const started = performance.now();
    await advanceFrames(60);
    const updateCommits = commits.mock.calls.length - initialCommits;
    const resamplingCalls = sampling.mock.calls.length - initialSampling;
    const metrics = {
      fixture: `${edgeCount} long edges / 60 frames`,
      updateCommits,
      resamplingCalls,
      queuedRafCallbacks: frames.size,
      harnessElapsedMs: Math.round(performance.now() - started),
    };
    if (process.env.AIFISHER_EDGE_METRICS_PATH) {
      writeFileSync(process.env.AIFISHER_EDGE_METRICS_PATH, JSON.stringify(metrics, null, 2));
    }
    console.log(JSON.stringify(metrics));
    expect(updateCommits).toBe(0);
    expect(resamplingCalls).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('keeps source-to-target flow on the original cubic with three repeating pulses', () => {
    const { container } = render(React.createElement(Harness, { nodes: longEdges(1) }));
    const visible = container.querySelector('[data-fisherai-edge-visible]')!;
    const layers = [...container.querySelectorAll<SVGPathElement>('.aifisher-edge-flow-pulse')];
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(layer.getAttribute('d')).toBe(visible.getAttribute('d'));
      expect(layer.getAttribute('d')).toContain(' C ');
      expect(layer.getAttribute('pathLength')).toBe('1');
      const [dash, gap] = layer.getAttribute('stroke-dasharray')!.split(' ').map(Number);
      expect(dash).toBeGreaterThan(0);
      expect(gap).toBeGreaterThan(0);
      expect(dash + gap).toBeCloseTo(1 / 3);
      const from = Number(layer.style.getPropertyValue('--af-edge-flow-from'));
      const to = Number(layer.style.getPropertyValue('--af-edge-flow-to'));
      expect(to - from).toBeCloseTo(-1);
      expect(layer.style.filter).toBe('none');
    }
    const css = container.querySelector('style')!.textContent!;
    expect(css).toContain('2.5s linear infinite');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(container.querySelector('filter')).toBeNull();
  });

  it('retains hover feedback, selection-independent preview and connection click actions', () => {
    const onEdgeClick = vi.fn();
    const onEdgeDoubleClick = vi.fn();
    const { container } = render(
      React.createElement(Harness, {
        nodes: longEdges(1),
        selectedNodeIds: [],
        onEdgeClick,
        onEdgeDoubleClick,
      }),
    );
    const edge = container.querySelector('[data-edge-key]')!;
    expect(container.querySelector('.edge-flow-segments')).toBeNull();
    fireEvent.mouseEnter(edge);
    expect(edge.getAttribute('data-fisherai-edge-hovered')).toBe('true');
    expect(
      container.querySelector('.edge-flow-segments')!.getAttribute('data-fisherai-edge-flow-tone'),
    ).toBe('danger');
    const hitTarget = container.querySelector('[data-fisherai-edge-hit-target]')!;
    expect(hitTarget.getAttribute('stroke-width')).toBe('32');
    fireEvent.click(hitTarget);
    expect(onEdgeClick).toHaveBeenCalledWith(expect.anything(), 'source-0', 'target-0', 0);
    fireEvent.doubleClick(hitTarget);
    expect(onEdgeDoubleClick).toHaveBeenCalledWith(expect.anything(), 'source-0', 'target-0', 0);
    fireEvent.mouseLeave(edge);
    expect(container.querySelector('.edge-flow-segments')).toBeNull();
  });

  it('reuses sampled geometry across zoom and mounts no flow for offscreen curves', () => {
    const nodes = longEdges(1);
    const lengths = vi.spyOn(edgeGeometry, 'edgeLength');
    const { container, rerender } = render(React.createElement(Harness, { nodes }));
    expect(container.querySelector('.edge-flow-segments')).not.toBeNull();
    const path = container.querySelector('[data-fisherai-edge-visible]')!.getAttribute('d');
    const initialSampling = lengths.mock.calls.length;
    rerender(React.createElement(Harness, { nodes, viewport: { x: 200, y: 100, zoom: 0.5 } }));
    expect(container.querySelector('[data-fisherai-edge-visible]')!.getAttribute('d')).toBe(path);
    expect(lengths.mock.calls.length).toBe(initialSampling);
    // The preload margin retains the hit target but does not animate an invisible edge.
    rerender(React.createElement(Harness, { nodes, viewport: { x: 0, y: -800, zoom: 1 } }));
    expect(container.querySelector('[data-fisherai-edge-visible]')).not.toBeNull();
    expect(container.querySelector('.edge-flow-segments')).toBeNull();
    rerender(React.createElement(Harness, { nodes, viewport: { x: 0, y: -6000, zoom: 1 } }));
    expect(container.querySelector('[data-edge-key]')).toBeNull();
    expect(frames.size).toBe(0);
  });

  it('uses one visibility listener to pause and resume all visible flows and cleans it up', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const { container, unmount } = render(React.createElement(Harness));
    const flows = () => [...container.querySelectorAll<SVGGElement>('.edge-flow-segments')];
    expect(flows()).toHaveLength(12);
    expect(
      flows().every(
        (flow) => flow.style.getPropertyValue('--af-edge-flow-play-state') === 'paused',
      ),
    ).toBe(true);
    expect(add.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    expect(
      flows().every(
        (flow) => flow.style.getPropertyValue('--af-edge-flow-play-state') === 'running',
      ),
    ).toBe(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(
      flows().every((flow) => flow.getAttribute('data-fisherai-edge-flow-paused') === 'true'),
    ).toBe(true);
    expect(frames.size).toBe(0);
    unmount();
    const added = add.mock.calls.find(([event]) => event === 'visibilitychange')!;
    expect(remove).toHaveBeenCalledWith('visibilitychange', added[1]);
  });

  it('keeps sixteen shared image-to-workflow port connections static while flowing', async () => {
    const sources: EdgeNode[] = Array.from({ length: 8 }, (_, index) => ({
      id: `image-${index}`,
      x: -1200,
      y: index * 32,
    }));
    const children: EdgeNode[] = [0, 1].map((index) => ({
      id: `workflow-${index}`,
      type: 'ComfyUI',
      x: 1800,
      y: index * 160,
      parentIds: ['', '', '', ...sources.map((node) => node.id), ...Array(7).fill('')],
    }));
    const onEdgeClick = vi.fn();
    const commits = vi.fn();
    const sampling = vi.spyOn(edgeGeometry, 'edgeFlowSegments');
    const { container } = render(
      React.createElement(Harness, {
        nodes: [...sources, ...children],
        selectedNodeIds: children.map((node) => node.id),
        onRender: commits,
        onEdgeClick,
      }),
    );
    expect(container.querySelectorAll('.edge-flow-segments')).toHaveLength(16);
    const initial = commits.mock.calls.length;
    await advanceFrames(60);
    expect(commits.mock.calls.length).toBe(initial);
    expect(sampling).not.toHaveBeenCalled();
    const last = container.querySelector('[data-edge-key="image-7-workflow-1-10"]')!;
    expect(last).not.toBeNull();
    fireEvent.click(last.querySelector('[data-fisherai-edge-hit-target]')!);
    expect(onEdgeClick).toHaveBeenCalledWith(expect.anything(), 'image-7', 'workflow-1', 10);
  });
});
