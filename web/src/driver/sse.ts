export interface StreamEvent { type: string; data: string }

/** SSE 多行 data 用换行连接；注释忽略，event 缺省为 message。 */
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
