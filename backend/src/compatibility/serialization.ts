export type JsonRecord = Record<string, unknown>;

export function projectSqliteRow(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[]
): JsonRecord {
  return Object.fromEntries(columns.map((column) => [column, Object.hasOwn(row, column) ? row[column] : null]));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)])
    );
  }
  return value;
}

export function encodePythonJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function decodeStoredJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function principalAsPythonDict(input: {
  readonly id: number | null;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly groups: readonly string[];
  readonly authenticated: boolean;
}): JsonRecord {
  return {
    id: input.id,
    name: input.name,
    username: input.name,
    email: input.email,
    role: input.role,
    groups: [...input.groups],
    authenticated: input.authenticated
  };
}
