// Minimal HTTP client. Any failure except 404 (429, 5xx, 401/403 bad key, network) throws
// ApiAbort so the run stops cleanly without writing anything. 404 returns null (token-level miss).
export class ApiAbort extends Error {}

const KEY = process.env.BIRDEYE_API_KEY ?? "";

/** Strip the API key from any text before it reaches a log. */
export function redact(s: string): string {
  return KEY ? s.split(KEY).join("***") : s;
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ApiAbort(redact(`network error: ${(e as Error).message}`));
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ApiAbort(`HTTP ${res.status} from ${new URL(url).host}${res.status === 429 ? " (rate limited)" : ""}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiAbort(`invalid JSON from ${new URL(url).host}`);
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ApiAbort(redact(`rpc network error: ${(e as Error).message}`));
  }
  if (!res.ok) throw new ApiAbort(`RPC HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: unknown };
  return j.error ? null : (j.result ?? null);
}
