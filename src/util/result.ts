export function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function jsonResult(data: unknown, space?: number) {
  const text =
    space === undefined
      ? JSON.stringify(data)
      : JSON.stringify(data, null, space);
  return textResult(text);
}
