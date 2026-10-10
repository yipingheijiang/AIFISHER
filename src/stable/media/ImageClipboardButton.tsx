import { useEffect, useRef, useState } from 'react';
import { copyCanvasImageToClipboard } from './imageClipboard';

export function ImageClipboardButton({ url, label = '复制图片' }: { url: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [error, setError] = useState('');
  const current = useRef<string | null>(url);
  useEffect(() => {
    current.current = url; setStatus('idle'); setError('');
    return () => { current.current = null; };
  }, [url]);
  async function copy() {
    if (status === 'copying') return;
    setStatus('copying'); setError('');
    try {
      const copied = await copyCanvasImageToClipboard(url);
      if (current.current === url) setStatus(copied ? 'copied' : 'idle');
    } catch (failure) {
      if (current.current !== url) return;
      setStatus('idle');
      setError(failure instanceof Error ? failure.message : '图片复制失败，请重试。');
    }
  }
  return <div className="relative" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" aria-label={label} title="复制原图，可粘贴到 Codex" disabled={status === 'copying'}
      onClick={event => { event.stopPropagation(); void copy(); }}
      className="inline-flex items-center gap-1 rounded-md border border-white/20 bg-black/70 px-2 py-1.5 text-xs text-white shadow-lg hover:bg-black disabled:opacity-50">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      </svg>
      <span role="status">{status === 'copying' ? '正在复制' : status === 'copied' ? '已复制' : '复制图片'}</span>
    </button>
    {error && <div role="alert" className="absolute right-0 top-full mt-1 w-52 rounded bg-black/90 p-2 text-xs text-white">{error}</div>}
  </div>;
}
