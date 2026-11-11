import { useCallback } from "react";

import { UnauthorizedError } from "./api";
import { useToast } from "./components/feedback";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 请求失败的统一出口。
 *
 * 未授权交给登出；其余默认弹提示，例："保存失败：连接超时"。
 * 给了 into 就把原因写进页面上的错误位，不弹提示。
 */
export function useFailure(onUnauthorized: (message: string) => void) {
  const toast = useToast();

  return useCallback(
    (err: unknown, options: { prefix?: string; into?: (message: string) => void } = {}) => {
      if (err instanceof UnauthorizedError) {
        onUnauthorized(err.message);
        return;
      }

      const message = errorMessage(err);
      if (options.into) options.into(message);
      else toast(options.prefix ? `${options.prefix}：${message}` : message, { tone: "error" });
    },
    [onUnauthorized, toast],
  );
}
