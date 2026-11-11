import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";

import { UnauthorizedError, fetchModelsPreview } from "./api";
import {
  isQuickImportUrl,
  parseQuickImportCandidates,
  readQuickImportModels,
  sameQuickImportConnection,
  suggestQuickImportName,
} from "./quickImport";
import type { QuickImportCandidates, QuickImportConnection } from "./quickImport";

export interface QuickImportProps {
  open: boolean;
  onSubmit: (name: string, baseUrl: string, apiKey: string | null, modelNames: string[]) => void;
  onClose: () => void;
  onUnauthorized: (message: string) => void;
}

interface QuickImportForm extends QuickImportConnection {
  name: string;
  nameManual: boolean;
  connectionManual: boolean;
  urlChoice: string;
  keyChoice: string;
}

export interface QuickImportPreview {
  connection: QuickImportConnection;
  models: string[];
  returned: ReadonlySet<string>;
  picked: ReadonlySet<string>;
}

function emptyForm(): QuickImportForm {
  return { name: "", baseUrl: "", apiKey: "", nameManual: false, connectionManual: false, urlChoice: "manual", keyChoice: "none" };
}

function emptyCandidates(): QuickImportCandidates {
  return { name: "", urls: [], keys: [] };
}

export function useQuickImport({ open, onSubmit, onClose, onUnauthorized }: QuickImportProps) {
  const [raw, setRaw] = useState("");
  const [parsedRaw, setParsedRaw] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<QuickImportCandidates>(emptyCandidates);
  const [form, setForm] = useState<QuickImportForm>(emptyForm);
  const [parseError, setParseError] = useState("");
  const [rawHidden, setRawHidden] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [view, setView] = useState<"connection" | "models">("connection");
  const [preview, setPreview] = useState<QuickImportPreview | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");
  const [modelNote, setModelNote] = useState("");
  const rawRef = useRef(raw);
  const formRef = useRef(form);
  const previewRef = useRef(preview);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const cancelPull = useCallback(() => {
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
    setPulling(false);
  }, []);

  useEffect(() => {
    if (open) return;
    cancelPull();
    setShowKey(false);
    setRawHidden(rawRef.current.length > 0);
    setView("connection");
  }, [open, cancelPull]);

  useEffect(() => () => {
    requestId.current += 1;
    controller.current?.abort();
  }, []);

  function commitForm(next: QuickImportForm) {
    if (!sameQuickImportConnection(formRef.current, next)) {
      cancelPull();
      setPullError("");
    }
    formRef.current = next;
    setForm(next);
  }

  function commitPreview(next: QuickImportPreview | null) {
    previewRef.current = next;
    setPreview(next);
  }

  function writeRaw(next: string) {
    if (next !== rawRef.current) {
      cancelPull();
      setPullError("");
    }
    rawRef.current = next;
    setRaw(next);
    setParseError("");
  }

  function parseRaw(value = rawRef.current) {
    const source = value.replace(/\r\n?/g, "\n");
    writeRaw(source);
    let result: QuickImportCandidates;
    try { result = parseQuickImportCandidates(source); }
    catch (error) { setParseError(error instanceof Error ? error.message : "无法识别这段文本。"); return; }
    const current = formRef.current;
    const baseUrl = result.urls.length === 1 ? result.urls[0].value : "";
    commitForm({
      name: current.nameManual ? current.name : result.name || suggestQuickImportName(baseUrl),
      baseUrl,
      apiKey: result.keys.length === 1 ? result.keys[0].value : "",
      nameManual: current.nameManual,
      connectionManual: false,
      urlChoice: result.urls.length === 1 ? "0" : result.urls.length > 1 ? "pending" : "manual",
      keyChoice: result.keys.length === 1 ? "0" : result.keys.length > 1 ? "pending" : "none",
    });
    setCandidates(result);
    setParsedRaw(source);
    setShowKey(false);
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget;
    const inserted = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!inserted) return;
    const next = input.value.slice(0, input.selectionStart) + inserted + input.value.slice(input.selectionEnd);
    event.preventDefault();
    writeRaw(next);
    if (!formRef.current.connectionManual) parseRaw(next);
  }

  function updateField(field: "name" | "baseUrl" | "apiKey", value: string) {
    const current = formRef.current;
    const next = { ...current, [field]: value };
    if (field === "name") next.nameManual = true;
    else {
      next.connectionManual = true;
      if (field === "baseUrl") {
        next.urlChoice = "manual";
        if (!next.nameManual) next.name = candidates.name || suggestQuickImportName(value);
      } else next.keyChoice = value.trim() ? "manual" : "none";
    }
    commitForm(next);
  }

  function chooseUrl(choice: string) {
    const next = { ...formRef.current, urlChoice: choice, connectionManual: true };
    if (choice !== "manual") next.baseUrl = choice === "pending" ? "" : candidates.urls[Number(choice)]?.value ?? "";
    if (!next.nameManual) next.name = candidates.name || suggestQuickImportName(next.baseUrl);
    commitForm(next);
  }

  function chooseKey(choice: string) {
    const next = { ...formRef.current, keyChoice: choice, connectionManual: true };
    if (choice !== "manual") next.apiKey = choice === "none" || choice === "pending" ? "" : candidates.keys[Number(choice)]?.value ?? "";
    commitForm(next);
  }

  function reset(focus: boolean) {
    cancelPull();
    rawRef.current = "";
    setRaw(""); setParsedRaw(null); setCandidates(emptyCandidates());
    commitForm(emptyForm()); commitPreview(null);
    setParseError(""); setPullError(""); setModelNote("");
    setRawHidden(false); setShowKey(false); setView("connection");
    if (focus) requestAnimationFrame(() => document.getElementById("quick-import-source")?.focus());
  }

  function close() {
    cancelPull();
    setShowKey(false); setRawHidden(rawRef.current.length > 0); setView("connection");
    onClose();
  }

  function cancel() {
    if (view === "models") setView("connection");
    else close();
  }
  async function pullModels() {
    if (connectionProblem || controller.current) return;
    const current = formRef.current;
    const connection = { baseUrl: current.baseUrl.trim(), apiKey: current.apiKey.trim() };
    const request = ++requestId.current;
    const abort = new AbortController();
    controller.current = abort;
    setPulling(true); setPullError(""); setModelNote("");
    try {
      const models = readQuickImportModels(await fetchModelsPreview(connection.baseUrl, connection.apiKey || null, { signal: abort.signal }));
      if (request !== requestId.current || abort.signal.aborted) return;
      const previous = previewRef.current;
      const keep = previous && sameQuickImportConnection(previous.connection, connection) ? previous : null;
      // 同一连接刷新只补候选，不重选用户取消的模型，也不移除未返回项。
      commitPreview({
        connection,
        models: keep ? [...new Set([...keep.models, ...models])] : models,
        returned: new Set(models),
        picked: new Set(keep ? keep.picked : models),
      });
    } catch (error) {
      if (request !== requestId.current || abort.signal.aborted) return;
      if (error instanceof UnauthorizedError) onUnauthorized(error.message);
      else {
        const message = error instanceof Error ? error.message : "拉取模型失败。";
        setPullError(connection.apiKey ? message.split(connection.apiKey).join("[密钥已隐藏]") : message);
      }
    } finally {
      if (request === requestId.current) { controller.current = null; setPulling(false); }
    }
  }

  function skipModels() {
    cancelPull(); commitPreview(null); setPullError("");
    setModelNote("已选择暂不带入精确模型，下一步可补充模型规则。");
    setView("connection");
  }

  function changeModels(names: readonly string[], selected: boolean) {
    const current = previewRef.current;
    if (!current || !sameQuickImportConnection(current.connection, formRef.current)) return;
    const picked = new Set(current.picked);
    const available = new Set(current.models);
    for (const name of names) {
      if (!available.has(name)) continue;
      if (selected) picked.add(name); else picked.delete(name);
    }
    commitPreview({ ...current, picked });
  }

  function submit() {
    if (submitProblem) return;
    const current = formRef.current, models = previewRef.current;
    if (models && !sameQuickImportConnection(models.connection, current)) return;
    onSubmit(current.name.trim(), current.baseUrl.trim(), current.apiKey.trim() || null,
      models ? models.models.filter((name) => models.picked.has(name)) : []);
    reset(false);
  }
  const rawChanged = parsedRaw === null ? raw.trim() !== "" : raw !== parsedRaw;
  const stale = Boolean(preview && !sameQuickImportConnection(preview.connection, form));
  const connectionProblem = parseError || (rawChanged ? "原文有更改，请先重新识别。"
    : !isQuickImportUrl(form.baseUrl) ? "请确认完整的 HTTP / HTTPS 接口地址。"
    : form.keyChoice === "pending" ? "请选择一把 Key，或明确选择暂不提供。" : "");
  const submitProblem = connectionProblem || (!form.name.trim() ? "请填写渠道名称。"
    : form.name.trim().length > 80 ? "渠道名称不能超过 80 个字符。"
    : pulling ? "正在拉取模型，可等待或暂不带入模型。"
    : stale ? "连接信息已变化，请刷新目录或暂不带入模型。" : "");
  const canAdjust = Boolean(preview?.models.length && !pulling && !stale && !connectionProblem);
  // 原文和字段都还空着：界面不挂状态徽标，也不报“待完善”。
  const pristine = !raw.trim() && !form.name && !form.baseUrl && !form.apiKey;

  return {
    raw, parsed: parsedRaw !== null, rawChanged, candidates, form, parseError, rawHidden, showKey,
    preview, pulling, pullError, modelNote, stale, view, submitProblem, pristine,
    canPull: !connectionProblem && !pulling, canAdjust,
    initialFocus: view === "models" ? "#quick-import-model-search" : rawHidden ? "#quick-import-name" : "#quick-import-source",
    writeRaw, parseRaw, paste, updateField, chooseUrl, chooseKey, pullModels, skipModels, changeModels, submit,
    close, cancel,
    clear: () => reset(true),
    toggleRaw: () => setRawHidden((value) => !value),
    toggleKey: () => setShowKey((value) => !value),
    showModels: () => { if (canAdjust) setView("models"); },
    showConnection: () => setView("connection"),
  };
}

export type QuickImportController = ReturnType<typeof useQuickImport>;
