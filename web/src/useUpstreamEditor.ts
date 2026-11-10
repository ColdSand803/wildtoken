import { useEffect, useMemo, useRef, useState } from "react";
import type { FormState, UpstreamPayload } from "./components/UpstreamDialog";
import type { DraftKey, Upstream } from "./types";
import type { KeyRow } from "./keyRows";
import { probeKeyOf } from "./keyRows";
import { parseMappingLines } from "./mappingLines";
import { UnauthorizedError, fetchModelsPreview } from "./api";
import { useConfirm, useToast } from "./components/feedback";
import { useDialog } from "./useDialog";
import { upstreamChanges, upstreamConnectionStamp, UPSTREAM_FIELD_TABS } from "./upstreamEditing";
import type { UpstreamErrors, UpstreamTab } from "./upstreamEditing";
import type { UpstreamCatalog } from "./components/UpstreamModelsWorkspace";

export interface UpstreamEditorProps {
  open: boolean;
  upstream: Upstream | null;
  draftKeys?: DraftKey[];
  /** 打开就落在“管理模型”并拉一次目录：列表菜单的「拉取模型」用。 */
  startInModels?: boolean;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  onSubmit: (payload: UpstreamPayload) => void;
  onClose: () => void;
}

interface Helpers {
  emptyForm: () => FormState;
  formFromUpstream: (upstream: Upstream, keys?: DraftKey[]) => FormState;
  payloadFromForm: (form: FormState) => UpstreamPayload;
  parseHeaderLines: (value: string) => Record<string, string>;
}

function commitManual(form: FormState): FormState {
  if (form.manual.includes("=>")) throw new Error("这里只填写模型名，名称改写请使用模型映射。");
  const names = form.manual.split(/[\s,，]+/).map((name) => name.trim()).filter(Boolean);
  return names.length || form.manual ? { ...form, modelNames: [...new Set([...form.modelNames, ...names])], manual: "" } : form;
}

function validateMappings(value: string, label: string, foldCase = false): void {
  const seen = new Set<string>();
  for (const [index, raw] of value.split("\n").entries()) {
    if (!raw.trim()) continue;
    if (raw.includes("=>")) {
      const sides = raw.split("=>");
      if (sides.length !== 2 || sides.some((part) => !part.trim())) throw new Error(`${label}第 ${index + 1} 行需要完整的“请求值 => 上游值”。`);
    }
    const pairs = Object.entries(parseMappingLines(raw, label));
    if (!pairs.length || pairs.some(([from, to]) => !from || !to)) throw new Error(`${label}第 ${index + 1} 行需要填写两侧名称。`);
    for (const [from, to] of pairs) {
      const key = foldCase ? from.toLowerCase() : from;
      if (seen.has(key)) throw new Error(`${label}的请求值“${from}”重复，请只保留一条。`);
      if (foldCase && (from.length > 32 || to.length > 32 || /\s/.test(from + to))) throw new Error("思考强度应为不含空白且不超过 32 个字符的名称。");
      seen.add(key);
    }
  }
  if (foldCase && seen.size > 32) throw new Error("思考强度映射最多配置 32 条。");
}

function validate(form: FormState, helpers: Helpers): UpstreamErrors {
  const errors: UpstreamErrors = {};
  if (!form.name.trim() || [...form.name.trim()].length > 80 || /[\x00-\x1f\x7f]/.test(form.name)) errors.name = "填写 1–80 个字符的渠道名称，不能包含控制字符。";
  try { const url = new URL(form.baseUrl.trim()); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
  catch { errors.baseUrl = "请填写完整的 http:// 或 https:// 地址。"; }
  for (const [field, min, max, integer] of [
    ["priority", 0, 100000, true], ["weight", 0, 10000, true], ["timeoutSeconds", 0, 3600, false],
  ] as const) {
    if (field === "timeoutSeconds" && !form[field].trim()) continue;
    const number = Number(form[field]);
    if (!form[field].trim() || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) errors[field] = `请输入 ${min}–${max} 之间的${integer ? "整数" : "数值"}。`;
  }
  try { helpers.parseHeaderLines(form.extraHeaders); } catch (error) { errors.extraHeaders = error instanceof Error ? error.message : "请求头格式无效。"; }
  for (const field of ["modelMappings", "effortMappings"] as const) {
    try { validateMappings(form[field], field === "modelMappings" ? "模型映射" : "思考强度映射", field === "effortMappings"); }
    catch (error) { errors[field] = error instanceof Error ? error.message : "映射格式无效。"; }
  }
  const rate = form.rateLimit.trim();
  if (rate) {
    const match = rate.match(/^(\d+)\/(\d+)?([smhd])$/);
    if (!match || rate.length > 24) errors.rateLimit = "使用 次数/时间窗口，例如 100/m、50/10s。";
    else {
      const count = BigInt(match[1]), window = BigInt(match[2] || "1");
      const unit = { s: 1n, m: 60n, h: 3600n, d: 86400n }[match[3] as "s" | "m" | "h" | "d"];
      if (count <= 0n || count > 9223372036854775807n || window <= 0n || window * unit * 1000000000n > 9223372036854775807n) errors.rateLimit = "请求数和时间窗口必须为有效正整数，时间窗口不能超出范围。";
    }
  }
  return errors;
}

export function useUpstreamEditor(props: UpstreamEditorProps, helpers: Helpers) {
  const { open, upstream, draftKeys, startInModels, groups, busy, onClose, onSubmit } = props;
  const [form, setForm] = useState(helpers.emptyForm);
  const [baseline, setBaseline] = useState(form);
  const [tab, setTab] = useState<UpstreamTab>("connection");
  const [workspace, setWorkspace] = useState(false);
  const [review, setReview] = useState(false);
  const [session, setSession] = useState(0);
  const [errors, setErrors] = useState<UpstreamErrors>({});
  const [catalog, setCatalog] = useState<UpstreamCatalog | null>(null);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  // 管理模型里的操作结果就地显示：toast 落在右上角，会盖住抽屉的启用开关和关闭按钮。
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const formRef = useRef(form);
  const generation = useRef(0);
  const pendingClose = useRef(false);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm(), toast = useToast();
  const changes = useMemo(() => upstreamChanges(baseline, form, groups), [baseline, form, groups]);
  const dirty = changes.length > 0;

  function cancelFetch() {
    request.current += 1; abort.current?.abort(); abort.current = null; setFetching(false);
  }

  function commit(next: FormState) {
    if (upstreamConnectionStamp(next) !== upstreamConnectionStamp(formRef.current)) {
      cancelFetch(); setFetchError("");
    }
    formRef.current = next; setForm(next);
    setKnownNames((current) => [...new Set([...current, ...next.modelNames])]);
  }

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    if (busy) return;
    commit({ ...formRef.current, [field]: value });
    setErrors((current) => { const next = { ...current }; delete next[field]; return next; });
  }

  function setKeys(update: (rows: KeyRow[]) => KeyRow[]) {
    if (!busy) set("keys", update(formRef.current.keys));
  }

  function selectTab(next: UpstreamTab, focus = false) {
    setWorkspace(false); setReview(false); setTab(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    if (focus) requestAnimationFrame(() => document.getElementById(`ue-tab-${next}`)?.focus());
  }

  function manageModels() { setTab("models"); setWorkspace(true); setReview(false); }
  function backToRules() {
    setWorkspace(false);
    requestAnimationFrame(() => document.getElementById("ue-manage-models")?.focus({ preventScroll: true }));
  }

  function focusError(field: keyof FormState) {
    setTab(UPSTREAM_FIELD_TABS[field]); setWorkspace(field === "manual"); setReview(false);
    requestAnimationFrame(() => {
      const element = dialogRef.current?.querySelector<HTMLElement>(`[data-ue-field="${field}"]`);
      if (!element) return;
      for (let parent = element.parentElement; parent && parent !== dialogRef.current; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      if (field !== "manual" && bodyRef.current) {
        const body = bodyRef.current;
        body.scrollTop = Math.max(0, body.scrollTop + element.getBoundingClientRect().top - body.getBoundingClientRect().top - 24);
      }
      (element.matches("input,textarea,select") ? element : element.querySelector<HTMLElement>("input,textarea,select") || element).focus({ preventScroll: true });
    });
  }

  function fail(field: keyof FormState, message: string) { setErrors((current) => ({ ...current, [field]: message })); focusError(field); }

  async function requestClose() {
    if (busy || pendingClose.current) return;
    if (!dirty) { cancelFetch(); onClose(); return; }
    const version = generation.current;
    pendingClose.current = true;
    const discard = await confirm({ title: "放弃未保存的修改？", message: "本次修改尚未保存，关闭后将恢复为上次保存的配置。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true });
    pendingClose.current = false;
    if (discard && version === generation.current) { cancelFetch(); onClose(); }
  }

  function escape() {
    if (review) { setReview(false); requestAnimationFrame(() => document.getElementById("ue-review-changes")?.focus()); }
    else if (workspace) backToRules();
    else void requestClose();
  }

  const dialogRef = useDialog(open, () => { void requestClose(); });

  function addManual(): boolean {
    try {
      const before = formRef.current, next = commitManual(before);
      setErrors((current) => { const updated = { ...current }; delete updated.manual; return updated; });
      commit(next);
      const count = next.modelNames.length - before.modelNames.length;
      if (before.manual.trim()) setNotice({ text: count ? `已添加 ${count} 项，保存渠道后生效。` : "这些模型已在选择中。" });
      return true;
    } catch (error) { fail("manual", error instanceof Error ? error.message : "模型名格式无效。"); return false; }
  }
  useEffect(() => {
    generation.current += 1;
    cancelFetch();
    setFetchError(""); setNotice(null); setReview(false); setWorkspace(false); setErrors({});
    if (!open) return;
    const next = upstream ? helpers.formFromUpstream(upstream, draftKeys) : helpers.emptyForm();
    formRef.current = next; setForm(next); setBaseline(next); setKnownNames([...next.modelNames]);
    setCatalog(null); setTab("connection"); setSession((value) => value + 1);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;

    if (startInModels) {
      // 焦点由管理模型自己放到搜索框。
      setTab("models"); setWorkspace(true);
      void fetchCatalog();
      return;
    }
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('[data-ue-field="name"]')?.focus({ preventScroll: true }));
  }, [open, upstream, draftKeys, startInModels]);

  useEffect(() => () => { request.current += 1; abort.current?.abort(); }, []);
  useEffect(() => {
    if (!open || !dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [open, dirty]);
  async function fetchCatalog() {
    if (busy || abort.current) return;
    const current = formRef.current;
    const connectionErrors = validate({ ...current, name: current.name || "未命名", modelMappings: "", effortMappings: "", priority: "100", weight: "100", rateLimit: "" }, helpers);
    for (const field of ["baseUrl", "extraHeaders", "timeoutSeconds"] as const) {
      if (connectionErrors[field]) { fail(field, connectionErrors[field]); return; }
    }
    const source = upstreamConnectionStamp(current), identity = ++request.current;
    const controller = new AbortController(); abort.current = controller;
    setFetching(true); setFetchError("");
    try {
      // 显隐不改变鉴权来源：未修改的已存 Key 仍通过服务端引用取用。
      const keys = current.keys.map((key) => key.revealed !== null && key.value === key.revealed ? { ...key, value: "" } : key);
      const probe = probeKeyOf(keys), upstreamId = upstream?.id ?? 0;
      const timeout = Number(current.timeoutSeconds);
      const result = await fetchModelsPreview(current.baseUrl.trim(), probe.apiKey, {
        extraHeaders: helpers.parseHeaderLines(current.extraHeaders),
        timeoutSeconds: timeout > 0 ? timeout : undefined,
        storedKey: upstreamId > 0 && probe.storedKeyId > 0 ? { upstreamId, keyId: probe.storedKeyId } : undefined,
        signal: controller.signal,
      });
      if (identity !== request.current || controller.signal.aborted || source !== upstreamConnectionStamp(formRef.current)) return;
      if (!Array.isArray(result.models) || !result.models.every((name) => typeof name === "string")) throw new Error("返回中没有有效的模型列表。");
      const names = [...new Set(result.models.map((name) => name.trim()).filter(Boolean))];
      setCatalog({ names, source }); setKnownNames((known) => [...new Set([...known, ...names, ...formRef.current.modelNames])]);
      setNotice({ text: `已拉取 ${names.length} 个模型，已有选择保持不变。` });
    } catch (error) {
      if (identity !== request.current || controller.signal.aborted) return;
      if (!(error instanceof UnauthorizedError)) {
        let message = error instanceof Error ? error.message : "无法拉取模型目录。";
        for (const key of current.keys) for (const secret of [key.value, key.revealed]) if (secret) message = message.split(secret).join("[密钥已隐藏]");
        for (const value of Object.values(helpers.parseHeaderLines(current.extraHeaders))) if (value) message = message.split(value).join("[请求头已隐藏]");
        setFetchError(message);
      }
    } finally {
      if (identity === request.current) { abort.current = null; setFetching(false); }
    }
  }

  function submit() {
    if (busy) return;
    let committed: FormState;
    try { committed = commitManual(formRef.current); }
    catch (error) { fail("manual", error instanceof Error ? error.message : "模型输入格式无效。"); return; }
    commit(committed);
    const nextErrors = validate(committed, helpers);
    setErrors(nextErrors);
    const first = Object.keys(nextErrors)[0] as keyof FormState | undefined;
    if (first) { focusError(first); return; }
    try { onSubmit(helpers.payloadFromForm(committed)); }
    catch (error) { toast(error instanceof Error ? error.message : "无法保存渠道。", { tone: "error" }); }
  }
  return {
    form, errors, tab, workspace, review, session, catalog, knownNames, fetching, fetchError, notice,
    stale: Boolean(catalog && catalog.source !== upstreamConnectionStamp(form)), changes, dirty,
    dialogRef, bodyRef, set, setKeys, selectTab, manageModels, backToRules, addManual, fetchCatalog, submit,
    close: () => { void requestClose(); }, escape,
    toggleReview: () => setReview((value) => !value), hideReview: () => setReview(false),
  };
}

export type UpstreamEditorController = ReturnType<typeof useUpstreamEditor>;
