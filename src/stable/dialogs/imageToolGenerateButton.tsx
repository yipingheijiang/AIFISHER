import * as React from 'react';
import { ArrowUp } from 'lucide-react';
export function ImageToolGenerateButton({
  label,
  onClick,
  editing = false,
}: {
  label: string;
  editing?: boolean;
  aspectRatio?: string;
  onClick(): void;
}) {
  const clicked = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  return (
    <button
      className="primary"
      aria-label={label}
      disabled={pending}
      title={editing ? '保存角度参数' : '创建本地草稿，在新节点选择模型后生成'}
      onClick={() => {
        if (clicked.current) return;
        clicked.current = true;
        setPending(true);
        try {
          onClick();
        } finally {
          clicked.current = false;
          setPending(false);
        }
      }}
    >
      {label}
      <ArrowUp size={17} />
    </button>
  );
}
