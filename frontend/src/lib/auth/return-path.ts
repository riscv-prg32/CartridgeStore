const RETURN_PATH_ORIGIN = "https://prg32-return.invalid";

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function decodedCandidate(value: string): string | null {
  let current = value;
  try {
    for (let index = 0; index < 3; index += 1) {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return current;
      current = decoded;
    }
    return current;
  } catch {
    return null;
  }
}

/** Mirrors the backend local-path policy and rejects encoded open redirects. */
export function safeReturnPath(value: string | null | undefined): string {
  const candidate = value ?? "/";
  const decoded = decodedCandidate(candidate);
  if (
    candidate.length > 512 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    hasControlCharacter(candidate) ||
    decoded === null ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    hasControlCharacter(decoded)
  ) {
    return "/";
  }

  try {
    const parsed = new URL(candidate, RETURN_PATH_ORIGIN);
    if (parsed.origin !== RETURN_PATH_ORIGIN) return "/";
  } catch {
    return "/";
  }
  return candidate;
}
