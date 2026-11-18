export function LoadError({ error, label, onRetry }: {
  error: string;
  label: string;
  onRetry: () => unknown;
}) {
  if (!error) return null;
  return (
    <p className="settings-inline-status" role="alert">
      {`读取${label}失败：${error}`}
      {" "}
      <button type="button" className="secondary ghost" aria-label={`重试加载${label}`} onClick={() => { onRetry(); }}>
        重试
      </button>
    </p>
  );
}
