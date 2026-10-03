export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/(password|secret|token|authorization|api[_-]?key)/i.test(key)) {
        return [key, "***"];
      }
      return [key, redactSensitive(entry)];
    }),
  );
}
