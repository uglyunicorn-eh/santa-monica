/**
 * Whether a browser origin may call the API. `allowed` is ALLOWED_ORIGINS: a comma-separated list of exact origins
 * (`https://gnomik.me`) and subdomain patterns (`https://*.santa-57a.pages.dev`, for the frontend's PR previews).
 * Requests without an Origin (servers, curl) aren't browser requests and get no CORS headers either way.
 */
export function originAllowed(origin: string, allowed: string): boolean {
  return allowed.split(',').map(entry => entry.trim()).filter(Boolean).some(entry => {
    const wildcard = /^(https?:\/\/)\*\.(.+)$/.exec(entry);
    if (!wildcard) {
      return origin === entry;
    }
    // One subdomain label, nothing more: `https://abc123.santa-57a.pages.dev`, not `https://evil.com/.santa-57a.pages.dev`.
    const [, scheme, domain] = wildcard;
    const label = origin.startsWith(scheme) && origin.endsWith(`.${domain}`) ? origin.slice(scheme.length, -(domain.length + 1)) : '';
    return /^[a-z0-9-]+$/.test(label) && origin === `${scheme}${label}.${domain}`;
  });
}
