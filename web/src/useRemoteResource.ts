import { useCallback, useEffect, useState } from "react";

import { LatestRequest } from "./driver/latestRequest";
import { useFailure } from "./useFailure";

interface ResourceState<T> {
  data: T | null;
  error: string;
  pending: boolean;
}

export function useRemoteResource<T>(
  read: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: (message: string) => void,
  enabled = true,
) {
  const [requests] = useState(() => new LatestRequest());
  const [state, setState] = useState<ResourceState<T>>({ data: null, error: "", pending: enabled });
  const fail = useFailure(onUnauthorized);

  const reload = useCallback(async (): Promise<T | undefined> => {
    if (!enabled) return;
    const request = requests.start();
    setState((current) => ({ ...current, error: "", pending: true }));
    try {
      const data = await read(request.signal);
      if (!request.current()) return;
      setState({ data, error: "", pending: false });
      return data;
    } catch (error) {
      if (!request.current()) return;
      fail(error, { into: (message) => setState((current) => ({ ...current, error: message })) });
    } finally {
      if (request.current()) setState((current) => ({ ...current, pending: false }));
    }
  }, [requests, read, fail, enabled]);

  useEffect(() => {
    if (enabled) void reload();
    else setState((current) => ({ ...current, pending: false }));
    return () => requests.invalidate();
  }, [requests, reload, enabled]);

  const update = useCallback((next: T | ((current: T | null) => T)) => {
    requests.invalidate();
    setState((current) => ({
      data: typeof next === "function" ? (next as (current: T | null) => T)(current.data) : next,
      error: "",
      pending: false,
    }));
  }, [requests]);

  return {
    ...state,
    loading: state.pending && state.data === null,
    refreshing: state.pending && state.data !== null,
    reload,
    update,
  };
}
