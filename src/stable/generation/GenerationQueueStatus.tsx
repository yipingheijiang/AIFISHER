import { useEffect, useRef, useState } from 'react';

interface QueueNode {
  id: string;
  projectId?: string;
  status?: unknown;
  generationAttemptId?: unknown;
  generationQueuePosition?: unknown;
}

interface QueueControlProps {
  node: QueueNode;
  onUpdate(id: string, patch: Record<string, unknown>): void;
}

// A node can expose the same action on both its card and its selected composer.
const cancellations = new Map<string, Promise<{ ok: boolean; body: Record<string, unknown> }>>();
function cancelWaiting(node: QueueNode) {
  const key = JSON.stringify([node.projectId || 'default', node.id, node.generationAttemptId]);
  const existing = cancellations.get(key);
  if (existing) return existing;
  const operation = fetch(`/api/generation-cancel/${encodeURIComponent(node.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: node.projectId || 'default', attemptId: node.generationAttemptId, onlyQueued: true }),
  }).then(async response => ({ ok: response.ok, body: await response.json() as Record<string, unknown> }));
  cancellations.set(key, operation);
  const clear = () => { if (cancellations.get(key) === operation) cancellations.delete(key); };
  void operation.then(clear, clear);
  return operation;
}

/** Cancels only a still-waiting attempt; admission racing the click cannot cancel the provider. */
export function GenerationQueueStatus({ node, onUpdate, compact = false }: QueueControlProps & { compact?: boolean }) {
  const latest = useRef({ node, onUpdate });
  latest.current = { node, onUpdate };
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  if (node.status !== 'queued') return null;
  const position = Number(node.generationQueuePosition);
  const cancel = async () => {
    if (pending.current || !node.generationAttemptId) return;
    const expected = node;
    pending.current = true;
    setCancelling(true);
    setError('');
    try {
      const response = await cancelWaiting(node);
      const result = response.body;
      const current = latest.current.node;
      if (!active.current || current.id !== expected.id || current.projectId !== expected.projectId || current.generationAttemptId !== expected.generationAttemptId) return;
      if (!response.ok) throw new Error(result.code === 'GENERATION_NOT_QUEUED' ? '任务已开始生成，无法取消排队。' : typeof result.error === 'string' ? result.error : '未能取消排队，请稍后重试。');
      if (result.status === 'cancelled' && result.remoteMayContinue === false) {
        latest.current.onUpdate(node.id, {
          status: 'cancelled', generationAttemptId: undefined, generationStartTime: undefined,
          generationQueuePosition: undefined, generationQueuedAt: undefined, generationExecutionStartedAt: undefined,
          generationDiagnosticCode: 'GENERATION_CANCELLED', errorMessage: '已取消排队。',
        });
      }
    } catch (failure) {
      if (active.current && latest.current.node.generationAttemptId === expected.generationAttemptId)
        setError(failure instanceof Error ? failure.message : '未能取消排队，请稍后重试。');
    } finally {
      pending.current = false;
      if (active.current) setCancelling(false);
    }
  };
  return <div className={`${compact ? 'text-center' : 'mb-2'} text-xs text-[var(--af-warning)]`} data-fisherai-queue-status="true">
    <div className={`flex items-center ${compact ? 'justify-center' : 'justify-between'} gap-2`}>
      {!compact && <span role="status" aria-live="polite">{position > 0 ? `排队中 · 第 ${position} 位` : '等待调度'}</span>}
      <button type="button" className={`${compact ? 'rounded-md border border-[var(--af-border-control)] bg-[var(--af-surface)] px-4 py-2 shadow-lg hover:bg-[var(--af-hover)]' : 'underline'} disabled:opacity-50`} aria-label="取消排队"
        disabled={cancelling || !node.generationAttemptId}
        onClick={event => { event.stopPropagation(); void cancel(); }}>
        {cancelling ? '正在取消' : '取消排队'}
      </button>
    </div>
    {error && <div role="alert">{error}</div>}
  </div>;
}

/** Visible on the node itself, independently of the selected generation composer. */
export function GenerationQueueCardControl(props: QueueControlProps) {
  if (props.node.status !== 'queued') return null;
  return <div data-fisherai-queue-card-controls="true" className="absolute bottom-3 left-3 right-3 z-30 pointer-events-auto"
    onPointerDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}>
    <GenerationQueueStatus {...props} compact />
  </div>;
}
