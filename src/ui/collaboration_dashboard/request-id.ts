type RequestEntry = {
  requestId: string;
  fingerprint: string | undefined;
  status: string;
};

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) output[key] = stableValue(input[key]);
    }
    return output;
  }
  return value;
}

export function fingerprint(payload: unknown): string | undefined {
  return JSON.stringify(stableValue(payload || {}));
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function generateRequestId(
  operation: unknown,
  timestamp: number = Date.now(),
  token: string = randomToken(),
): string {
  return `ui:${String(operation || "operation")}:${timestamp}:${token}`;
}

export function nextRequest(
  previous: RequestEntry | null | undefined,
  operation: unknown,
  payload: unknown,
): RequestEntry {
  const nextFingerprint = fingerprint(payload);
  if (previous && previous.status !== "succeeded" && previous.fingerprint === nextFingerprint) {
    return previous;
  }
  return {
    requestId: generateRequestId(operation),
    fingerprint: nextFingerprint,
    status: "pending",
  };
}

export function markRequest(
  entry: RequestEntry | null | undefined,
  status: string,
): RequestEntry | null {
  return entry ? { ...entry, status } : null;
}