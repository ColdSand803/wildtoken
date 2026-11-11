import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listLogClientTypes, listLogs } from "./api";
import { clientTypeOptions } from "./clientTypes";
import { LatestRequest } from "./driver/latestRequest";
import { activeMatchesFilters, logMatchesFilters } from "./logFilter";
import type { LogFilters } from "./logFilter";
import { appendLogCursor, mergeLogRows, needsLogResync } from "./logQuery";
import type { LogCursor } from "./logQuery";
import type { RequestLogPage } from "./types";
import { useFailure } from "./useFailure";
import { useLogStream } from "./useLogStream";

export function useLogQuery(onUnauthorized: (message: string) => void) {
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [upstreamFilter, setUpstreamFilter] = useState("");
  const [channelInput, setChannelInput] = useState("");
  const [clientTypes, setClientTypes] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [cursors, setCursors] = useState<LogCursor[]>([]);
  const [missedNew, setMissedNew] = useState(false);
  const [requests] = useState(() => new LatestRequest());
  const coveredThrough = useRef(0);
  const streamNewest = useRef(0);
  const seenNewestId = useRef(0);
  const onLatestPage = cursors.length === 0;
  const fail = useFailure(onUnauthorized);

  const load = useCallback(async (cursor?: LogCursor) => {
    const request = requests.start();
    const streamedBefore = streamNewest.current;
    setLoading(true);
    try {
      const loaded = await listLogs({
        limit: pageSize, beforeCreatedAt: cursor?.created_at, beforeId: cursor?.id,
        search, clientType: clientFilter, status: statusFilter, upstreamId: upstreamFilter,
      }, request.signal);
      if (!request.current()) return;
      setPage(loaded);
      // 只计入查询发出前已提交的推送，不能拿完成时的值覆盖查询期间的新行。
      if (!cursor) coveredThrough.current = Math.max(streamedBefore, loaded.items[0]?.id ?? 0);
      setError("");
    } catch (error) {
      if (request.current()) fail(error, { into: setError });
    } finally {
      if (request.current()) setLoading(false);
    }
  }, [requests, fail, pageSize, search, clientFilter, statusFilter, upstreamFilter]);

  useEffect(() => {
    void load(cursors.at(-1));
    return () => requests.invalidate();
  }, [load, cursors, requests]);

  const backToLatest = useCallback(() => {
    setCursors((current) => current.length === 0 ? current : []);
  }, []);

  function applyFilter(set: (value: string) => void, value: string) {
    set(value);
    backToLatest();
  }

  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => { setSearch(searchInput); backToLatest(); }, 400);
    return () => clearTimeout(timer);
  }, [searchInput, search, backToLatest]);

  useEffect(() => {
    const value = channelInput.replace(/^0+(?=\d)/, "");
    if (value === upstreamFilter) return;
    const timer = setTimeout(() => { setUpstreamFilter(value); backToLatest(); }, 400);
    return () => clearTimeout(timer);
  }, [channelInput, upstreamFilter, backToLatest]);

  useEffect(() => {
    let current = true;
    listLogClientTypes().then((types) => { if (current) setClientTypes(types); }).catch(() => {});
    return () => { current = false; };
  }, []);

  const onResync = useCallback(() => {
    if (onLatestPage) void load();
    else setMissedNew(true);
  }, [load, onLatestPage]);
  const stream = useLogStream(true, onResync);
  const filters = useMemo<LogFilters>(
    () => ({ upstreamId: upstreamFilter, clientType: clientFilter, status: statusFilter, search }),
    [upstreamFilter, clientFilter, statusFilter, search],
  );

  useEffect(() => {
    if (onLatestPage) {
      for (const log of stream.logs) seenNewestId.current = Math.max(seenNewestId.current, log.id);
      setMissedNew(false);
    } else if (stream.logs.some((log) => log.id > seenNewestId.current && logMatchesFilters(log, filters))) {
      setMissedNew(true);
    }
  }, [stream.logs, onLatestPage, filters]);

  useEffect(() => {
    for (const log of stream.logs) streamNewest.current = Math.max(streamNewest.current, log.id);
  }, [stream.logs]);

  useEffect(() => {
    if (!needsLogResync(stream.evictedNewestId, coveredThrough.current, onLatestPage)) return;
    coveredThrough.current = stream.evictedNewestId;
    void load();
  }, [stream.evictedNewestId, onLatestPage, load]);

  const merged = useMemo(() => mergeLogRows(page?.items ?? [], stream.logs, onLatestPage, filters),
    [page?.items, stream.logs, onLatestPage, filters]);
  const logs = useMemo(() => merged.slice(0, pageSize), [merged, pageSize]);
  const hasMore = Boolean(page?.has_more) || merged.length > logs.length;
  const clientOptions = useMemo(() => clientTypeOptions(
    clientTypes, [...stream.logs, ...(page?.items ?? [])].map((log) => log.client_type), clientFilter,
  ), [clientTypes, stream.logs, page?.items, clientFilter]);

  const activeFromPage = page?.active ?? [];
  const activeLatest = stream.connected ? stream.active : activeFromPage;
  const active = onLatestPage
    ? activeLatest.filter((request) => activeMatchesFilters(request, filters))
    : [];
  const activeTotal = stream.connected ? stream.activeTotal : (page?.active_total ?? 0);

  function goLatest() { setCursors([]); setMissedNew(false); }
  return {
    logs, loading, error, active, activeLatest, activeTotal, clientOptions,
    connected: stream.connected, rpm: stream.rpm ?? page?.recent_rpm ?? null, tpm: stream.tpm ?? page?.recent_tpm ?? null,
    searchInput, setSearchInput, channelInput, setChannelInput, clientFilter, statusFilter,
    changeClient: (value: string) => applyFilter(setClientFilter, value),
    changeStatus: (value: string) => applyFilter(setStatusFilter, value),
    pageSize, pageNumber: cursors.length + 1, onLatestPage, hasMore, missedNew, goLatest,
    changePageSize: (value: number) => { setPageSize(value); setCursors([]); },
    previousPage: () => setCursors((stack) => stack.slice(0, -1)),
    nextPage: () => setCursors((stack) => appendLogCursor(stack, logs)),
    reload: () => load(cursors.at(-1)),
  };
}

export type LogQuery = ReturnType<typeof useLogQuery>;
