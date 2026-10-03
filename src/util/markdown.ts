export function markdownCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function markdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "_No rows._";
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  const header = `| ${keys.map(markdownCell).join(" | ")} |`;
  const rule = `| ${keys.map(() => "---").join(" | ")} |`;
  const body = rows
    .map(
      (row) => `| ${keys.map((key) => markdownCell(row[key])).join(" | ")} |`,
    )
    .join("\n");
  return `${header}\n${rule}\n${body}`;
}
