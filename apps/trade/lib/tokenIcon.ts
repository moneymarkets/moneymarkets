import { apiUrl } from './basePath';
import { initialsFor } from './wallet/sendRecipients';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Our own icon route for a token. The browser never loads a third-party image. */
export function tokenIconSrc(address: string): string {
  return apiUrl(`/api/token-icon/${address.toLowerCase()}`);
}

/**
 * Addresses whose icon already failed to load in this page's life, so a remounted row
 * starts on the mark instead of flashing a broken image first.
 */
const failedIcons = new Set<string>();

export function noteIconFailed(address: string): void {
  failedIcons.add(address.toLowerCase());
}

export function iconHasFailed(address: string): boolean {
  return failedIcons.has(address.toLowerCase());
}

export type TokenIconView = { kind: 'img'; src: string } | { kind: 'mark'; text: string };

/**
 * What a token icon draws: our route's image for a real address that has not failed,
 * otherwise the two-letter mark. Never a broken image.
 */
export function tokenIconView(input: { address: string | null | undefined; symbol: string; failed: boolean }): TokenIconView {
  if (!input.failed && input.address && ADDRESS.test(input.address)) {
    return { kind: 'img', src: tokenIconSrc(input.address) };
  }
  return { kind: 'mark', text: initialsFor(input.symbol) };
}
