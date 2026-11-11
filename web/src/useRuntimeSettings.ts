import { useEffect, useState } from "react";

import { APIError, getSettings, saveSettings } from "./api";
import { useToast } from "./components/feedback";
import { acceptSavedCard, rebaseSettings, settingsForCard } from "./settingsDraft";
import type { SettingsCard, SettingsField } from "./settingsDraft";
import type { RuntimeSettings } from "./types";
import { useFailure } from "./useFailure";
import { useKeyedActions } from "./useKeyedActions";
import { useRemoteResource } from "./useRemoteResource";

interface Editor {
  base: RuntimeSettings;
  draft: RuntimeSettings;
}

export function useRuntimeSettings(onUnauthorized: (message: string) => void) {
  const resource = useRemoteResource(getSettings, onUnauthorized);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [savingCard, setSavingCard] = useState<SettingsCard | null>(null);
  const { run } = useKeyedActions<"save">();
  const fail = useFailure(onUnauthorized);
  const toast = useToast();

  useEffect(() => {
    const latest = resource.data;
    if (!latest) return;
    setEditor((current) => ({
      base: latest,
      draft: current ? rebaseSettings(current.base, current.draft, latest) : latest,
    }));
  }, [resource.data]);

  function patch<K extends SettingsField>(key: K, value: RuntimeSettings[K]) {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, [key]: value } } : current);
  }

  async function save(card: SettingsCard) {
    if (!editor) return;
    const submitted = editor.draft;
    await run("save", async () => {
      setSavingCard(card);
      try {
        const result = await saveSettings(settingsForCard(editor.base, submitted, card));
        setEditor((current) => ({
          base: result,
          draft: acceptSavedCard(current?.draft ?? submitted, submitted, result, card),
        }));
        toast("设置已保存。", { tone: "ok" });
      } catch (error) {
        if (error instanceof APIError && error.status === 409) {
          const latest = await resource.reload();
          if (latest) toast("设置已被修改，已载入最新版本并保留本地草稿。请确认后再次保存。", { tone: "warn" });
        } else {
          fail(error, { prefix: "保存失败" });
        }
      } finally {
        setSavingCard(null);
      }
    });
  }

  return { settings: editor?.draft ?? null, loading: resource.loading, error: resource.error, reload: resource.reload, savingCard, patch, save };
}

export type RuntimeSettingsEditor = ReturnType<typeof useRuntimeSettings>;
