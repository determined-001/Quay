/**
 * Joins a SEP-defined path onto a service URL discovered from stellar.toml.
 *
 * `new URL("/quote", "https://a.com/sep38")` resolves to `https://a.com/quote` —
 * it throws away the path the anchor advertised. Every TOML service URL may
 * carry a path prefix (testanchor's ANCHOR_QUOTE_SERVER is `.../sep38`), so
 * paths must be appended, never resolved as absolute.
 */
export function endpoint(serviceUrl: string, path: string, params?: Record<string, string | undefined>): URL {
  const base = serviceUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  const url = new URL(suffix ? `${base}/${suffix}` : base);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return url;
}
