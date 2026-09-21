import { useEffect, useRef, useState } from "react";

import { getAdminToken } from "./api";
import type { ActiveRequest, RequestLog } from "./types";

const STREAM_PATH = "/api/admin/logs/stream";

/* 和旧控制台同一组参数。改动要两边一起改，否则观感会漂。 */
const BATCH_RENDER_MS = 80;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** 连上超过这个时长才把退避计数清零，否则一直闪断会立刻重试到上限。 */
const STABLE_CONNECTION_MS = 5000;
const MAX_BUFFER_CHARS = 1_000_000;

/** SSE 帧解析结果。event 缺省是 "message"，和规范一致。 */
interface StreamEvent {
  type: string;
  data: string;
}

/**
 * 解析一个 SSE 帧。
 *
 * 按字段名收集，data 可以有多行、用 \n 连接。冒号开头的是注释行，丢掉。
 */
export function parseStreamEvent(frame: string): StreamEvent {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value || "message";
    else if (field === "data") data.push(value);
  }
  return { type, data: data.join("\n") };
}

export interface LogStreamState {
  /** 已结束的请求，最新在前。 */
  logs: RequestLog[];
  /** 在途请求。服务端发的是全量快照，不是增量。 */
  active: ActiveRequest[];
  /** 并发数读这个，不是 active.length——那个列表有上限截断。 */
  activeTotal: number;
  connected: boolean;
  rpm: number | null;
  tpm: number | null;
}

/**
 * 订阅日志流。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：认证走 x-admin-token 头，
 * 原生 EventSource 不支持自定义请求头。
 *
 * 三种事件：
 *   log     一条新日志
 *   active  在途请求全量快照
 *   resync  服务端要求重新拉取（本 hook 只置标志，拉取由调用方做）
 */
export function useLogStream(enabled: boolean, onResync: () => void): LogStreamState {
  const [state, setState] = useState<LogStreamState>({
    logs: [],
    active: [],
    activeTotal: 0,
    connected: false,
    rpm: null,
    tpm: null,
  });

  /* onResync 放进 ref：把它列进 deps 会让调用方每次重渲染都重连，
     而重连意味着丢掉当前缓冲。 */
  const resyncRef = useRef(onResync);
  resyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, connected: false }));
      return;
    }

    const controller = new AbortController();
    let attempts = 0;
    let reconnectTimer: number | null = null;
    let batchTimer: number | null = null;
    let pending: RequestLog[] = [];
    let stopped = false;

    /* 新日志先攒着，80ms 冲一次。高频时逐条 setState 会让 React 每条
       都重渲染一次整张表。 */
    const flush = () => {
      batchTimer = null;
      if (pending.length === 0) return;
      const incoming = pending;
      pending = [];
      setState((prev) => {
        const seen = new Set(prev.logs.map((log) => log.id));
        const fresh = incoming.filter((log) => !seen.has(log.id));
        if (fresh.length === 0) return prev;
        return { ...prev, logs: [...fresh, ...prev.logs].slice(0, 200) };
      });
    };

    const scheduleFlush = () => {
      if (batchTimer !== null) return;
      batchTimer = window.setTimeout(flush, BATCH_RENDER_MS);
    };

    const handleEvent = (event: StreamEvent) => {
      if (event.type === "resync") {
        resyncRef.current();
        return;
      }
      if (event.type === "active") {
        try {
          const payload = JSON.parse(event.data) as {
            requests?: ActiveRequest[];
            total?: number;
          };
          if (!Array.isArray(payload.requests)) return;
          setState((prev) => ({
            ...prev,
            active: payload.requests ?? [],
            activeTotal: payload.total ?? payload.requests?.length ?? 0,
          }));
        } catch {
          // 坏帧丢掉即可：下一个快照是全量的，会把状态纠回来。
          return;
        }
        return;
      }
      if (event.type !== "log" || !event.data) return;
      try {
        const record = JSON.parse(event.data) as {
          log?: RequestLog;
          recent_rpm?: number;
          recent_tpm?: number;
        };
        if (record.recent_rpm != null && record.recent_tpm != null) {
          const rpm = record.recent_rpm;
          const tpm = record.recent_tpm;
          setState((prev) => ({ ...prev, rpm, tpm }));
        }
        if (record.log) {
          pending.push(record.log);
          scheduleFlush();
        }
      } catch {
        // 同上：单条坏帧不值得断掉整个流。
        return;
      }
    };

    const consume = async (body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const drain = () => {
        for (;;) {
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
          if (!boundary) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          handleEvent(parseStreamEvent(frame));
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // 没有帧边界却越攒越大，说明对端在发不成形的东西。
          if (buffer.length > MAX_BUFFER_CHARS) throw new Error("日志流返回了过大的未完成事件");
          drain();
        }
        buffer += decoder.decode();
        drain();
      } finally {
        reader.releaseLock();
      }
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== null) return;
      const exponent = Math.min(attempts, 5);
      const base = Math.min(RECONNECT_MIN_MS * 2 ** exponent, RECONNECT_MAX_MS);
      attempts += 1;
      // 抖动，避免多个标签页同时醒来。
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stopped) return;
      const token = getAdminToken();
      if (!token) {
        /* 还没登录。不能就此放弃——用户待会就会在弹框里输令牌，
           而那不会重新触发这个 effect。排一次重试，退避逻辑会把间隔
           拉开，不会忙等。 */
        scheduleReconnect();
        return;
      }
      let openedAt = 0;
      try {
        const response = await fetch(STREAM_PATH, {
          cache: "no-store",
          headers: { Accept: "text/event-stream", "x-admin-token": token },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        if (!response.body) throw new Error("日志流不可用");
        openedAt = Date.now();
        setState((prev) => ({ ...prev, connected: true }));
        // 重连后可能漏了行，让调用方补一次全量。
        if (attempts > 0) resyncRef.current();
        await consume(response.body);
      } catch {
        /* 断线是常态，安静重连。这里不能报错：流断了列表和手动刷新
           照常可用，弹一堆错误反而扰民。finally 里排重连。 */
        return;
      } finally {
        if (!stopped) {
          setState((prev) => ({ ...prev, connected: false }));
          // 连稳过才清退避计数，否则闪断会直接冲到上限。
          if (openedAt && Date.now() - openedAt >= STABLE_CONNECTION_MS) attempts = 0;
          scheduleReconnect();
        }
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (batchTimer !== null) window.clearTimeout(batchTimer);
    };
  }, [enabled]);

  return state;
}
