import { Component } from "react";
import type { ReactNode } from "react";

/** 一块结果渲染失败，不卸载其他页面；新一轮请求用 key 重置。 */
export class ResultBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
