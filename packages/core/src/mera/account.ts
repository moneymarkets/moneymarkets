import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { mnemonicToAccount } from 'viem/accounts';
import type { Address, LocalAccount } from 'viem';

/**
 * Mera: a passkey becomes an account.
 *
 * Read from `@category-labs/mera@0.2.0` (the published package, not documentation):
 *
 *   createPasskeyWithPrfOutput({ rp, user })  -> credential metadata + 32-byte PRF output
 *   getPasskeyPrfOutput({ rpId, credential }) -> { credentialId, prfOutput }
 *   createSecp256k1SigningSession({ privateKey }) -> session with signDigest / end
 *   toViemAccount(session)  (from "@category-labs/mera/viem") -> viem LocalAccount
 *   getEvmAddress(publicKey) -> EIP-55 address
 *
 * ## Open item 14 — do signing sessions cover EIP-712?
 *
 * Yes. `@category-labs/mera/viem`'s `toViemAccount` documents that it implements
 * `signMessage` (EIP-191), `signTypedData` (EIP-712), `signTransaction` and
 * `signAuthorization` (EIP-7702), and that "each signing method hashes its input
 * with viem's own hashers and signs the resulting 32-byte digest with
 * `session.signDigest`, so **signing never shows a passkey prompt**." A trader is
 * therefore not asked for Face ID on every order, which is what FR-02 requires.
 *
 * ## PRF constraints, from the package's own docs
 *
 * The PRF assertion always requires user verification and the requirement is not
 * configurable: WebAuthn exposes only the user-verified PRF. An authenticator with
 * no PRF support throws `PRF_UNAVAILABLE` — the case the onboarding screen has copy
 * for. The default salt is `sha256("mera.prf.salt.v1")` and is stable across library
 * versions, so an account derived today resolves tomorrow.
 *
 * ## Derivation
 *
 * The 32-byte PRF output is used as BIP-39 entropy, producing a mnemonic whose
 * `m/44'/60'/0'/0/0` key is the account. That makes recovery real: the phrase
 * imports into MetaMask or Rabby and yields the same address (US-7 AC2).
 *
 * 32 bytes of entropy is a 24-word phrase. `design/05-design-system.md` §5.6 draws
 * twelve. Truncating to 16 bytes to fit the drawing would cut the recovery path to
 * 128 bits while the passkey path keeps 256 — a real asymmetry for a cosmetic
 * reason. Recorded as a conflict in DECISIONS.md; the spec governs logic, the design
 * governs appearance, and word count is the former.
 */

export const MERA_DERIVATION_PATH = "m/44'/60'/0'/0/0" as const;

/** Shape of `PasskeyCredentialMetadata` in `@category-labs/mera@0.2.0`. */
export interface PasskeyCredential {
  readonly credentialId: string;
  readonly transports?: readonly string[];
}

export interface MeraAccount {
  /** Base64url credential id. Holds no key material; safe in localStorage. */
  readonly credentialId: string;
  readonly address: Address;
  readonly account: LocalAccount;
}

export interface MeraRelyingParty {
  /** Must be identical on web and in the mobile shell, or the passkey resolves elsewhere. */
  readonly id: string;
  readonly name: string;
}

/**
 * The parts of `@category-labs/mera` this wrapper uses, named so tests can supply a
 * stand-in and so a build that never touches WebAuthn does not pull the library.
 */
export interface MeraModule {
  createPasskeyWithPrfOutput(options: {
    rp: MeraRelyingParty;
    user: { name: string; displayName: string };
    webAuthnClient?: unknown;
  }): Promise<{ credentialId: string; prfOutput: Uint8Array }>;
  getPasskeyPrfOutput(options: {
    rpId: string;
    credential?: PasskeyCredential;
    webAuthnClient?: unknown;
  }): Promise<{ credentialId: string; prfOutput: Uint8Array }>;
}

/**
 * Where the passkey should live.
 *
 * `'any'` lets the browser choose, which on a phone is the right answer and on a
 * Windows desktop usually means the local profile store — the one provider that
 * cannot evaluate PRF, so the account cannot be derived from it. `'phone'` asks the
 * browser for the hybrid transport and gets the QR-code flow instead.
 */
export type PasskeyLocation = 'any' | 'phone';

async function ceremonyClientFor(where: PasskeyLocation): Promise<unknown> {
  if (where !== 'phone') return undefined;
  const { ceremonyClient } = await import('./crossDevice.js');
  return ceremonyClient('phone');
}

let cachedModule: MeraModule | undefined;

async function loadMera(): Promise<MeraModule> {
  if (cachedModule) return cachedModule;
  const mod = (await import('@category-labs/mera')) as unknown as MeraModule;
  cachedModule = mod;
  return mod;
}

/** For tests and for the dev demo page. */
export function setMeraModule(module: MeraModule | undefined): void {
  cachedModule = module;
}

/**
 * Turn a 32-byte PRF output into a BIP-39 mnemonic. The mnemonic is the recovery
 * artefact; nothing else in this app ever writes it down.
 */
export function prfOutputToMnemonic(prfOutput: Uint8Array): string {
  if (prfOutput.length !== 32) {
    throw new Error(`PRF output must be 32 bytes to derive an account, got ${prfOutput.length}`);
  }
  // A fresh copy: entropyToMnemonic must not alias a buffer the caller will zero.
  return entropyToMnemonic(Uint8Array.from(prfOutput), wordlist);
}

export function accountFromMnemonic(mnemonic: string): LocalAccount {
  const account = mnemonicToAccount(mnemonic, { path: MERA_DERIVATION_PATH });

  /**
   * Drop `getHdKey` before the account leaves this function.
   *
   * viem's `hdKeyToAccount` returns `{ ...account, getHdKey: () => hdKey }`, and
   * `getHdKey().privateKey` is the raw 32-byte secp256k1 key — verified against the
   * pinned viem 2.56.3, which returns exactly 32 bytes. It is a public method on a
   * plain object, not a closure, and that object is held in React state and published
   * through context. React attaches `__reactFiber$<hash>` to every host DOM node, so
   * any script executing in the page can walk from `document.body` to the provider's
   * hook state and read the key directly. No cooperation from the app is required.
   *
   * Removing it does not make the account safe — it still signs, and a script that can
   * reach it can still ask it to sign anything. What this removes is the one-shot
   * total grab: exfiltrating a key is permanent and unrecoverable, because the same key
   * is what the 24 words reproduce, so it cannot be rotated. Losing the ability to sign
   * while a page is compromised is a smaller loss than losing the key itself.
   *
   * `privateExtendedKey` goes with it for the same reason: it is the master chain code.
   *
   * The real fix is to hold the key in a worker and hand out a capability that only
   * signs. This is the cheap half of that, and it is worth having on its own.
   */
  const { getHdKey: _dropped, ...withoutKeyAccess } = account as typeof account & {
    getHdKey?: unknown;
  };
  return withoutKeyAccess as LocalAccount;
}

export function accountFromPrfOutput(prfOutput: Uint8Array): LocalAccount {
  return accountFromMnemonic(prfOutputToMnemonic(prfOutput));
}

export interface CreateAccountOptions {
  readonly rp: MeraRelyingParty;
  readonly user?: { name: string; displayName: string };
  /** Defaults to `'any'`. `'phone'` runs the cross-device (QR) ceremony. */
  readonly where?: PasskeyLocation;
}

/** One passkey ceremony, one account. Nothing is deployed and no seed phrase is shown. */
export async function createAccount(options: CreateAccountOptions): Promise<MeraAccount> {
  const mera = await loadMera();
  const webAuthnClient = await ceremonyClientFor(options.where ?? 'any');
  const { credentialId, prfOutput } = await mera.createPasskeyWithPrfOutput({
    rp: options.rp,
    user: options.user ?? { name: options.rp.name, displayName: options.rp.name },
    ...(webAuthnClient ? { webAuthnClient } : {}),
  });
  const account = accountFromPrfOutput(prfOutput);
  prfOutput.fill(0);
  return { credentialId, address: account.address, account };
}

export interface SignInOptions {
  readonly rpId: string;
  readonly credentialId?: string;
  /** Defaults to `'any'`. `'phone'` runs the cross-device (QR) ceremony. */
  readonly where?: PasskeyLocation;
}

export async function signIn(options: SignInOptions): Promise<MeraAccount> {
  const mera = await loadMera();
  const webAuthnClient = await ceremonyClientFor(options.where ?? 'any');
  const { credentialId, prfOutput } = await mera.getPasskeyPrfOutput({
    rpId: options.rpId,
    ...(options.credentialId ? { credential: { credentialId: options.credentialId } } : {}),
    ...(webAuthnClient ? { webAuthnClient } : {}),
  });
  const account = accountFromPrfOutput(prfOutput);
  prfOutput.fill(0);
  return { credentialId, address: account.address, account };
}

/**
 * Recovery phrase, for the settings screen only.
 *
 * Requires a fresh passkey assertion by construction: the phrase is re-derived from
 * a new PRF evaluation rather than kept anywhere. It is never logged and never
 * leaves the device (rule A4).
 */
export async function exportMnemonic(options: SignInOptions): Promise<string> {
  const mera = await loadMera();
  const { prfOutput } = await mera.getPasskeyPrfOutput({
    rpId: options.rpId,
    ...(options.credentialId ? { credential: { credentialId: options.credentialId } } : {}),
  });
  const mnemonic = prfOutputToMnemonic(prfOutput);
  prfOutput.fill(0);
  return mnemonic;
}

/**
 * Require a fresh passkey assertion, right now, for one action.
 *
 * ## Why an action needs this even though the account can already sign
 *
 * The signing key is derived once at sign-in and held in memory, so trading costs no
 * prompt — that is the product, and it is right for an order you can cancel. It is not
 * right for moving money out. `/send` transfers to an arbitrary recipient and
 * `/withdraw` moves funds out of the trading balance; both were reachable with a single
 * tap in an already-open session. A phone unlocked for thirty seconds, or one clickjack
 * over a confirm button, was the whole of the defence.
 *
 * The owner's rule: login, withdraw, send and recovery-phrase export prompt every time;
 * trading may use the session.
 *
 * ## It proves presence, and nothing else
 *
 * The PRF output is requested and immediately zeroed. Nothing is derived from it — the
 * account is already in memory. What the ceremony buys is the authenticator's own
 * verification that the human is here, which is exactly what a stolen session lacks.
 *
 * Throws if the user cancels. Callers must treat that as "nothing was signed", because
 * nothing was.
 */
export async function assertFreshPasskey(options: SignInOptions): Promise<void> {
  const mera = await loadMera();
  const { prfOutput } = await mera.getPasskeyPrfOutput({
    rpId: options.rpId,
    ...(options.credentialId ? { credential: { credentialId: options.credentialId } } : {}),
  });
  // Never used. Requested only so the authenticator performs user verification.
  prfOutput.fill(0);
}

export const CREDENTIAL_STORAGE_KEY = 'tradepro.credentialId';

/**
 * Every passkey this device has created or signed into, remembered so "Switch
 * account" (design: multi-account guard, 2026-09-04) can show each one's real
 * address and live balance without a Face ID prompt per row.
 *
 * This is the one deliberate widening of what rule A4 persists: an address is not
 * key material — it is the public value printed on every transaction the account
 * ever sends — so remembering it here changes what is stored, not what is
 * protected. Still no credential ever carries signing material off the
 * authenticator. See DECISIONS.md.
 */
export const ACCOUNTS_STORAGE_KEY = 'tradepro.accounts';

/** One row of `ACCOUNTS_STORAGE_KEY`. */
export interface StoredAccount {
  readonly credentialId: string;
  readonly address: Address;
}

/**
 * Parses whatever `ACCOUNTS_STORAGE_KEY` holds. Never throws: a corrupted or
 * hand-edited value is treated the same as no accounts remembered yet, not as a
 * reason to break the screen that reads it.
 */
export function readStoredAccounts(raw: string | null): readonly StoredAccount[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredAccount =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as StoredAccount).credentialId === 'string' &&
        typeof (entry as StoredAccount).address === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * `entry` moved to the front, replacing any earlier row for the same credential
 * rather than duplicating it — signing back into an already-remembered account
 * must not grow the list.
 */
export function withStoredAccount(
  accounts: readonly StoredAccount[],
  entry: StoredAccount,
): readonly StoredAccount[] {
  return [entry, ...accounts.filter((a) => a.credentialId !== entry.credentialId)];
}

/**
 * The account-related values **this module** persists in a browser. A credential id
 * is a public handle: it identifies which passkey to ask for and carries no key
 * material (rule A4). `ACCOUNTS_STORAGE_KEY` carries the same kind of thing, one
 * per account this device knows about, plus each one's public address.
 *
 * This is not an inventory of every `localStorage` key `apps/trade` writes — this
 * package cannot see the app's own modules (theme, notifications, the activity and
 * open-orders caches, the install-prompt dismissal, the dry-run log all live there,
 * not here). It is the narrower, still-real claim this module can actually make:
 * *of the keys the passkey layer itself writes, these two are all of them, and
 * neither carries key material* (audit M5 — the previous version of this comment
 * read as the broader claim, which the guarding test's self-referential assertion
 * could never have caught either way). `account.test.ts` checks the literal string
 * values, not this array against its own definition, and
 * `apps/trade/lib/storageKeys.test.ts` is where the whole app's `localStorage`
 * footprint is actually inventoried.
 */
export const PERSISTED_KEYS = [CREDENTIAL_STORAGE_KEY, ACCOUNTS_STORAGE_KEY] as const;
