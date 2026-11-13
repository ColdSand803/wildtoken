export function RoutingGuide() {
  return (
    <div className="routing-rule-guide">
      <ol className="routing-rule-steps">
        <li><strong>模型优先</strong><span>先保留模型匹配分最高的渠道；显式指定渠道时跳过池内权重选择。</span></li>
        <li><strong>优先级硬分层</strong><span>只要最高 priority 组内存在有效权重大于 0 的渠道，就不会使用更低 priority。</span></li>
        <li><strong>同层按策略选择</strong><span>选择有效权重随机或最低延迟优先；冷启动样本不足时仍按有效权重分流。</span></li>
        <li><strong>降到 0 后切换</strong><span>某一层全部为 0 才回退到下一层。渠道恢复为正数后，高优先级层会立即重新接管流量。</span></li>
      </ol>
      <p className="routing-rule-detail">
        有效权重由基础权重派生，范围为 0 到基础权重。所有上游非 2xx、连接失败、超时、读取失败和
        SSE 上游异常都会降低有效权重；正常完成的 2xx 请求会恢复有效权重。有效权重为 0
        时退出动态池，经过完整恢复周期后重新参与选择。
      </p>
      <p className="routing-rule-detail">
        自动路由的每次重试都会重新选择渠道。选到不同渠道立即重试；再次选到同一渠道才等待。
        显式指定渠道的重试始终等待。有可用重试时先等 SSE 首个有效事件再提交响应；提交后不再透明重试，避免重复输出。
      </p>
    </div>
  );
}
