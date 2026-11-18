import { useState } from "react";

export function NumberField({ name, label, value, min, max, step, hint, className, onChange }: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  className?: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={className ? `field ${className}` : "field"}>
      <span className="field-label">{label}</span>
      <input
        type="number"
        name={name}
        min={min}
        max={max}
        step={step}
        required
        inputMode={step !== undefined && step < 1 ? "decimal" : "numeric"}
        value={draft ?? value}
        onFocus={() => setDraft(String(value))}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          setDraft(event.target.value);
          // 清空是放弃输入，不把图片存储上限等设置清零。
          const raw = event.target.value.trim();
          const value = Number(raw);
          if (raw !== "" && Number.isFinite(value)) onChange(value);
        }}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
