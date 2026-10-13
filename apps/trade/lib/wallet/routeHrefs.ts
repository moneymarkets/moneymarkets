/**
 * Wallet route paths (spec §2), named once so a page's Back link and whatever
 * links to it cannot drift apart, and so `routes.test.ts` asserts against the same
 * strings the app actually navigates with.
 */

export const WALLET_HOME_HREF = '/wallet';
/** Mounts the existing Add money page (spec §4.2) under a Back link and the Wallet header. */
export const WALLET_RECEIVE_HREF = '/wallet/receive';
export const WALLET_SEND_HREF = '/wallet/send';
export const WALLET_SWAP_HREF = '/wallet/swap';
/** Wallet settings lives under Settings, not under `/wallet` (spec §4.6). */
export const WALLET_SETTINGS_HREF = '/settings/wallet';
/** The address book, under Wallet settings (spec §4.3, §4.6). Send's "+ New"
 *  chip links here rather than duplicating the add-address form. */
export const WALLET_ADDRESS_BOOK_HREF = '/settings/wallet/address-book';
