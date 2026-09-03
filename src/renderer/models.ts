/**
 * Renderer-side model-list client for the title-bar model selector.
 *
 * Headless by design (no DOM): `listModels` talks to the sidecar's
 * `GET /api/models` and `normalizeModelsResponse` validates whatever comes
 * back before the UI renders it, so a malformed payload degrades to an empty
 * list instead of reaching the dropdown.
 */

/** A model advertised by `GET /api/models` for the selector dropdown. */
export type ApiModel = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
};

/**
 * Validate and normalize a raw `/api/models` response body. Accepts either a
 * bare array (`ApiModel[]`) or an envelope (`{ models: ApiModel[] }`) and
 * drops entries that are not well-formed objects with a string id.
 */
export function normalizeModelsResponse(data: unknown): ApiModel[] {
  const rawList = Array.isArray(data) ? data : (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(rawList)) return [];
  const out: ApiModel[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) continue;
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      providerId: typeof m.providerId === 'string' ? m.providerId : '',
      providerName: typeof m.providerName === 'string' ? m.providerName : '',
    });
  }
  return out;
}

/** Fetch the current model list; any failure (or empty result) returns []. */
export async function listModels(): Promise<ApiModel[]> {
  try {
    const res = await fetch('/api/models', { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    return normalizeModelsResponse((await res.json()) as unknown);
  } catch {
    return [];
  }
}
