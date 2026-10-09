import { useEffect, useRef, useState } from 'react';

interface QueueNode {
  id: string;
  projectId?: string;
  status?: unknown;
  generationAttemptId?: unknown;
  generationQueuePosition?: unknown;
}

/** Cancels only a still-waiting attempt; admission racing the click cannot cancel the provider. */
export function GenerationQueueStatus({ node, onUpdate }: {
  node: QueueNode;
  onUpdate(id: string, patch: Record<string, unknown>): void;
}) {
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
      const response = await fetch(`/api/generation-cancel/${encodeURIComponent(node.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: node.projectId || 'default', attemptId: node.generationAttemptId, onlyQueued: true }),
      });
      const result = await response.json();
      const current = latest.current.node;
      if (!active.current || current.id !== expected.id || current.projectId !== expected.projectId || current.generationAttemptId !== expected.generationAttemptId) return;
      if (!response.ok) throw new Error(result.code === 'GENERATION_NOT_QUEUED' ? '任务已开始生成，无法取消排队。' : result.error || '未能取消排队，请稍后重试。');
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
  return <div className="mb-2 text-xs text-[var(--af-warning)]" data-fisherai-queue-status="true">
    <div className="flex items-center justify-between gap-2">
      <span role="status" aria-live="polite">{position > 0 ? `排队中 · 第 ${position} 位` : '等待调度'}</span>
      <button type="button" className="underline disabled:opacity-50" aria-label="取消排队"
        disabled={cancelling || !node.generationAttemptId}
        onClick={event => { event.stopPropagation(); void cancel(); }}>
        {cancelling ? '正在取消' : '取消排队'}
      </button>
    </div>
    {error && <div role="alert">{error}</div>}
  </div>;
}
