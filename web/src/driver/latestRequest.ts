/** 新读取取代旧读取；已过期的回调不能提交状态。 */
export class LatestRequest {
  private version = 0;
  private controller: AbortController | null = null;

  start() {
    this.invalidate();
    const version = this.version;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      current: () => this.version === version && !controller.signal.aborted,
    };
  }

  invalidate() {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
  }
}
