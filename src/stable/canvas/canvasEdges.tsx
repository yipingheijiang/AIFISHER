import type * as ReactTypes from 'react';
import { memo } from 'react';
import { edgeLength, edgePath, edgePhase, type Curve, type Point } from './canvasEdgeGeometry';
type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'useState' | 'useMemo' | 'useEffect' | 'useId'
>;
export interface EdgeNode {
  id: string;
  type?: string;
  x: number;
  y: number;
  parentIds?: string[];
  sourcePortIndices?: number[];
  [key: string]: unknown;
}
interface Connection {
  nodeId: string;
  handle: 'left' | 'right';
  portIndex?: number;
}
interface Props {
  nodes: EdgeNode[];
  viewport: { x: number; y: number; zoom: number };
  viewportSize?: { width: number; height: number };
  isDraggingConnection?: boolean;
  connectionStart?: Connection | null;
  tempConnectionEnd?: Point | null;
  batchConnectionSourceNodeIds?: string[];
  hoveredNodeId?: string | null;
  hoveredSide?: 'left' | 'right' | null;
  hoveredPortIndex?: number | null;
  isInvalidHover?: boolean;
  selectedNodeIds: string[];
  visibleNodeIds?: Set<string>;
  selectedConnection?: { parentId: string; childId: string; portIndex: number } | null;
  onEdgeClick(
    event: ReactTypes.MouseEvent,
    parentId: string,
    childId: string,
    portIndex: number,
  ): void;
  onEdgeDoubleClick?(
    event: ReactTypes.MouseEvent,
    parentId: string,
    childId: string,
    portIndex: number,
  ): void;
}
interface Geometry {
  getWidth(node: EdgeNode): number;
  getHeight(node: EdgeNode, parent?: EdgeNode): number;
  getPortX(node: EdgeNode, side: 'left' | 'right', width: number): number;
  getPortY(node: EdgeNode, side: 'left' | 'right', index: number, height: number): number;
}
interface ResolvedEdge {
  parentId: string;
  childId: string;
  portIndex: number;
  key: string;
  curve: Curve;
}
type RenderedEdge = ResolvedEdge & { path: string; length: number; phase: number };

// Immutable endpoint records are the cache keys. Moving/resizing either endpoint,
// changing its ports, or replacing the measurer invalidates only the affected edges.
// Weak keys release old drag positions; offscreen edges never need curve sampling.
function createEdgeGeometryCache(geometry: Geometry) {
  const sizes = new WeakMap<EdgeNode, { width: number; height: number }>();
  const endpoints = new WeakMap<EdgeNode, WeakMap<EdgeNode, Map<number, ResolvedEdge>>>();
  const rendered = new WeakMap<ResolvedEdge, RenderedEdge>();
  const size = (node: EdgeNode) => {
    let value = sizes.get(node);
    if (!value) {
      value = { width: geometry.getWidth(node), height: geometry.getHeight(node) };
      sizes.set(node, value);
    }
    return value;
  };
  return {
    size,
    resolve(parent: EdgeNode, child: EdgeNode, portIndex: number) {
      let parents = endpoints.get(child);
      if (!parents) endpoints.set(child, (parents = new WeakMap()));
      let ports = parents.get(parent);
      if (!ports) parents.set(parent, (ports = new Map()));
      let edge = ports.get(portIndex);
      if (!edge) {
        const parentSize = size(parent),
          childSize = size(child);
        edge = {
          parentId: parent.id,
          childId: child.id,
          portIndex,
          key: JSON.stringify([parent.id, child.id, portIndex]),
          curve: {
            start: {
              x: geometry.getPortX(parent, 'right', parentSize.width),
              y: geometry.getPortY(
                parent,
                'right',
                child.sourcePortIndices?.[portIndex] ?? 0,
                parentSize.height,
              ),
            },
            end: {
              x: geometry.getPortX(child, 'left', childSize.width),
              y: geometry.getPortY(child, 'left', portIndex, geometry.getHeight(child, parent)),
            },
          },
        };
        ports.set(portIndex, edge);
      }
      return edge;
    },
    render(edge: ResolvedEdge) {
      let value = rendered.get(edge);
      if (!value) {
        value = {
          ...edge,
          path: edgePath(edge.curve),
          length: edgeLength(edge.curve),
          phase: edgePhase(`${edge.parentId}-${edge.childId}-${edge.portIndex}`),
        };
        rendered.set(edge, value);
      }
      return value;
    },
  };
}

const EdgeFlow = memo(function EdgeFlow({
  edge,
  over,
  paused,
}: {
  edge: RenderedEdge;
  over: boolean;
  paused: boolean;
}) {
  const span = Math.min(
    0.16,
    Math.min(800, Math.max(32, edge.length * 0.5)) / Math.max(edge.length, 1),
  );
  // Native SVG dashing follows arc length, so a long curve has no parameter-speed
  // surges. Each static layer repeats three pulses; shorter, brighter layers share
  // the same head to form a tapered trail without per-frame React/geometry work.
  const layers = [
    { fraction: 1, width: 4, opacity: 0.07, core: false },
    { fraction: 1, width: 2, opacity: 0.15, core: false },
    { fraction: 0.7, width: 2, opacity: 0.24, core: false },
    { fraction: 0.44, width: 2, opacity: 0.38, core: false },
    { fraction: 0.2, width: 2, opacity: 0.9, core: false },
    { fraction: 0.05, width: 1, opacity: 1, core: true },
  ];
  return (
    <g
      data-fisherai-edge-flow-tone={over ? 'danger' : 'primary'}
      data-fisherai-edge-flow-paused={paused ? 'true' : 'false'}
      className="edge-flow-segments pointer-events-none"
      style={
        { '--af-edge-flow-play-state': paused ? 'paused' : 'running' } as ReactTypes.CSSProperties
      }
    >
      {layers.map((layer, index) => {
        const length = span * layer.fraction;
        return (
          <path
            key={index}
            className="aifisher-edge-flow-pulse"
            d={edge.path}
            pathLength={1}
            stroke={
              over
                ? layer.core
                  ? 'rgb(255, 224, 227)'
                  : 'rgb(255, 77, 90)'
                : layer.core
                  ? 'rgb(191, 219, 254)'
                  : 'rgb(59, 130, 246)'
            }
            strokeWidth={layer.width}
            strokeDasharray={`${length} ${1 / 3 - length}`}
            opacity={layer.opacity}
            fill="none"
            strokeLinecap="round"
            style={
              {
                '--af-edge-flow-from': length - edge.phase,
                '--af-edge-flow-to': length - edge.phase - 1,
                filter: 'none',
              } as ReactTypes.CSSProperties
            }
          />
        );
      })}
    </g>
  );
});

export function CanvasEdges(React: Runtime, props: Props, geometry: Geometry) {
  const { getWidth, getHeight, getPortX, getPortY } = geometry;
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [flowPaused, setFlowPaused] = React.useState(() => document.hidden);
  React.useEffect(() => {
    const visibility = () => setFlowPaused(document.hidden);
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  const { nodes, viewport, selectedConnection, selectedNodeIds } = props;
  const selected = React.useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const geometryCache = React.useMemo(
    () => createEdgeGeometryCache({ getWidth, getHeight, getPortX, getPortY }),
    [getWidth, getHeight, getPortX, getPortY],
  );
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const width = props.viewportSize?.width ?? window.innerWidth,
    height = props.viewportSize?.height ?? window.innerHeight;
  const edges = React.useMemo(() => {
    const bounds = {
      left: -viewport.x / zoom - 800,
      top: -viewport.y / zoom - 800,
      right: (width - viewport.x) / zoom + 800,
      bottom: (height - viewport.y) / zoom + 800,
    };
    return nodes.flatMap((child) =>
      (child.parentIds || []).flatMap((parentId, portIndex) => {
        const parent = parentId ? byId.get(parentId) : undefined;
        if (!parent) return [];
        const edge = geometryCache.resolve(parent, child, portIndex),
          { curve } = edge;
        // A long edge can cross the viewport while both endpoint cards are outside it.
        const horizontal = Math.abs(curve.end.x - curve.start.x) / 2;
        if (
          Math.max(curve.start.x + horizontal, curve.end.x) < bounds.left ||
          Math.min(curve.start.x, curve.end.x - horizontal) > bounds.right ||
          Math.max(curve.start.y, curve.end.y) < bounds.top ||
          Math.min(curve.start.y, curve.end.y) > bounds.bottom
        )
          return [];
        return [geometryCache.render(edge)];
      }),
    );
  }, [nodes, byId, geometryCache, viewport.x, viewport.y, zoom, width, height]);
  const temporary =
    props.isDraggingConnection && props.connectionStart && props.tempConnectionEnd
      ? [
          ...new Set(
            props.batchConnectionSourceNodeIds?.length
              ? props.batchConnectionSourceNodeIds
              : [props.connectionStart.nodeId],
          ),
        ].flatMap((id) => {
          const node = byId.get(id),
            start = props.connectionStart!,
            end = props.tempConnectionEnd!;
          if (!node) return [];
          const size = geometryCache.size(node);
          const target = props.hoveredNodeId ? byId.get(props.hoveredNodeId) : undefined;
          const side = props.hoveredSide;
          const index =
            target?.type === 'ComfyUI'
              ? (props.hoveredPortIndex ?? (side === 'left' ? target.parentIds?.length || 0 : 0))
              : 0;
          const curve: Curve = {
            start: {
              x: getPortX(node, start.handle, size.width),
              y: getPortY(node, start.handle, start.portIndex ?? 0, size.height),
            },
            end:
              target && side
                ? {
                    x: getPortX(target, side, geometryCache.size(target).width),
                    y: getPortY(
                      target,
                      side,
                      index,
                      geometryCache.size(target).height || getHeight(target, node),
                    ),
                  }
                : { x: (end.x - viewport.x) / zoom, y: (end.y - viewport.y) / zoom },
            side: start.handle,
          };
          return [
            <g key={`temp-${id}`} className="pointer-events-none">
              <path d={edgePath(curve)} stroke="var(--af-edge-halo)" strokeWidth="5" fill="none" />
              <path
                d={edgePath(curve)}
                stroke={
                  props.isInvalidHover
                    ? 'var(--af-danger)'
                    : target && side
                      ? 'var(--af-focus)'
                      : 'var(--af-edge)'
                }
                strokeWidth="2"
                strokeDasharray="5,5"
                fill="none"
                className="pointer-events-none"
              />
            </g>,
          ];
        })
      : null;
  return (
    <>
      <style>{`
        @keyframes aifisher-edge-flow {
          from { stroke-dashoffset: var(--af-edge-flow-from); }
          to { stroke-dashoffset: var(--af-edge-flow-to); }
        }
        .aifisher-edge-flow-pulse {
          animation: aifisher-edge-flow 2.5s linear infinite;
          animation-play-state: var(--af-edge-flow-play-state, running);
        }
        @media (prefers-reduced-motion: reduce) {
          .aifisher-edge-flow-pulse { animation: none; }
        }
      `}</style>
      {edges.map((edge) => {
        const chosen =
          selectedConnection?.parentId === edge.parentId &&
          selectedConnection.childId === edge.childId &&
          selectedConnection.portIndex === edge.portIndex;
        const related = selected.has(edge.parentId) || selected.has(edge.childId),
          highlighted = related || chosen,
          over = hovered === edge.key;
        // Keep the preloaded line/hit target, but animate only when its curve can be seen.
        // Bezier controls may cross the screen even if both endpoint cards are outside it.
        const horizontal = Math.abs(edge.curve.end.x - edge.curve.start.x) / 2;
        const flowVisible =
          Math.max(edge.curve.start.x + horizontal, edge.curve.end.x) >=
            (-viewport.x - 32) / zoom &&
          Math.min(edge.curve.start.x, edge.curve.end.x - horizontal) <=
            (width - viewport.x + 32) / zoom &&
          Math.max(edge.curve.start.y, edge.curve.end.y) >= (-viewport.y - 32) / zoom &&
          Math.min(edge.curve.start.y, edge.curve.end.y) <= (height - viewport.y + 32) / zoom;
        return (
          <g
            key={edge.key}
            data-edge-key={`${edge.parentId}-${edge.childId}-${edge.portIndex}`}
            onClick={(event) =>
              props.onEdgeClick(event, edge.parentId, edge.childId, edge.portIndex)
            }
            onDoubleClick={(event) =>
              props.onEdgeDoubleClick?.(event, edge.parentId, edge.childId, edge.portIndex)
            }
            onMouseEnter={() => setHovered(edge.key)}
            onMouseLeave={() => setHovered((current) => (current === edge.key ? null : current))}
            data-fisherai-edge-hovered={over ? 'true' : 'false'}
            className="cursor-pointer group pointer-events-auto fisherai-canvas-edge"
            style={{ opacity: highlighted || over ? 1 : 0.78 }}
          >
            <path
              data-fisherai-edge-hit-target="true"
              d={edge.path}
              stroke="transparent"
              strokeWidth="32"
              fill="none"
            />
            <path
              data-af-edge-halo
              d={edge.path}
              stroke="var(--af-edge-halo)"
              strokeWidth={highlighted ? 6.2 : 5.4}
              fill="none"
              className="pointer-events-none"
            />
            <path
              data-fisherai-edge-visible="true"
              d={edge.path}
              stroke="var(--af-edge)"
              strokeWidth={highlighted ? 3.2 : 2.4}
              fill="none"
              className="fisherai-edge-visible"
            />
            <g
              data-fisherai-edge-scissors="true"
              className="fisherai-edge-scissors pointer-events-none"
              transform={`translate(${(edge.curve.start.x + edge.curve.end.x) / 2} ${(edge.curve.start.y + edge.curve.end.y) / 2})`}
            >
              <title>双击断开连线</title>
              <circle
                r={15}
                fill="var(--af-surface-raised)"
                stroke="var(--fisherai-edge-danger)"
                strokeWidth={1.5}
              />
              <g
                fill="none"
                stroke="var(--af-text)"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M-7 -7L3 3M7 -7L-3 3" />
                <circle cx={-5} cy={6} r={3.2} />
                <circle cx={5} cy={6} r={3.2} />
              </g>
            </g>
            {(highlighted || over) && flowVisible && (
              <EdgeFlow edge={edge} over={over} paused={flowPaused} />
            )}
          </g>
        );
      })}
      {temporary}
    </>
  );
}
