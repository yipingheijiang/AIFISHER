import './generationWaiting.css';

export function GenerationWaiting({ operation = '图片生成', queued = false, position }: { operation?: string; queued?: boolean; position?: unknown }) {
  return <div data-fisherai-regeneration-overlay="true" className="af-generation-waiting" role="status" aria-live="polite">
    <span className="af-generation-waiting-ring" aria-hidden="true" />
    <strong>{queued ? '排队中' : '正在生成'}</strong>
    <span className="af-generation-waiting-operation">{operation}</span>
    <small>{queued ? (Number(position) > 0 ? `队列第 ${Number(position)} 位，空位后自动开始` : '等待调度，空位后自动开始') : '完成后自动显示结果'}</small>
  </div>;
}
