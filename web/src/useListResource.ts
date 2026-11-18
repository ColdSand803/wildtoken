import { useCallback } from "react";

import { useRemoteResource } from "./useRemoteResource";

const EMPTY_ITEMS: never[] = [];

export function useListResource<T>(
  read: (signal: AbortSignal) => Promise<T[]>,
  onUnauthorized: (message: string) => void,
) {
  const resource = useRemoteResource(read, onUnauthorized);
  const replace = resource.update;
  const update = useCallback((next: T[] | ((current: T[]) => T[])) => {
    replace((current) => typeof next === "function" ? next(current ?? []) : next);
  }, [replace]);

  return { ...resource, items: resource.data ?? EMPTY_ITEMS, update };
}
