/**
 * Where the app is mounted.
 *
 * Next rewrites its own routes and asset URLs for `basePath`, but it does not touch
 * a `fetch('/api/…')` written by hand — that string is sent exactly as typed. Under
 * `moneymarkets.trade` a bare `/api/account` would leave the app entirely
 * and land on whatever else the domain serves at `/api/`, so every call to our own
 * routes goes through `apiUrl()`.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function apiUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}
