/** 失败后换了渠道或 Key 的那次尝试。它不算一个请求，结果记在同一请求后面那行。 */
export function RetriedMark() {
  return (
    <span className="log-retried" title="这次尝试失败后换了渠道或 Key 重试，不算一个请求">
      已重试
    </span>
  );
}
