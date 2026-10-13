'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ACCOUNTS_STORAGE_KEY,
  CREDENTIAL_STORAGE_KEY,
  createAccount,
  readStoredAccounts,
  signIn,
  withStoredAccount,
  type MeraAccount,
  type PasskeyLocation,
  type StoredAccount,
} from '@tradepro/core';
import {
  classifySignInError,
  developerNoteFor,
  messageForSignInError,
  shouldLogToConsole,
  type SignInFailure,
} from './signInError';

/**
 * Who is signed in, for the length of one tab.
 *
 * The ability to sign anything lives in memory only and does not survive a reload —
 * that half of `account` is gone until the passkey is presented again. What does
 * survive is each account's credential id and public address, one row per account
 * this device has ever created or signed into (`accounts`), which is enough to show
 * every known account's real address and live balance without a prompt, but not
 * enough to sign, spend, or export anything for one that is not the active `account`
 * (rule A4 — a stored value never implies a signature).
 */

export type SessionStatus =
  /** Before localStorage has been read; nothing is known yet. */
  | 'loading'
  /** No credential on this device. */
  | 'new'
  /** A credential exists, but no account is unlocked in this tab. */
  | 'returning'
  | 'signed-in';

export interface SigningSession {
  readonly device: string;
  readonly startedAt: number;
}

export interface SessionValue {
  readonly status: SessionStatus;
  readonly account?: MeraAccount;
  readonly credentialId: string | null;
  /**
   * Every account this device has created or signed into before, most recently
   * used first — including the one currently signed in. Each entry's address and
   * balance can be shown without a passkey prompt; switching to one still needs a
   * fresh assertion (rule A4 — signing is never implied by a stored value).
   */
  readonly accounts: readonly StoredAccount[];
  readonly error?: string;
  /** Which failure produced `error`, so a screen can offer the matching way out. */
  readonly failure?: SignInFailure;
  readonly busy: boolean;
  readonly session?: SigningSession;
  create: (where?: PasskeyLocation) => Promise<void>;
  /** `targetCredentialId` picks a specific remembered account rather than the last one used. */
  authenticate: (where?: PasskeyLocation, targetCredentialId?: string) => Promise<void>;
  endSession: () => void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

/**
 * The relying-party id.
 *
 * Rule A4 wants one rpId pinned in config, and `NEXT_PUBLIC_RP_ID` is that pin: when
 * it is set it always wins, so a deployment cannot drift. It is deliberately *not*
 * set for local work, because a fixed value there is worse than none — a passkey
 * created against rpId "localhost" while the page is served from a tunnel hostname
 * fails with a SecurityError, and the tunnel hostname changes every time the tunnel
 * restarts. With no pin, the browser's own host is used, which is what WebAuthn would
 * default to anyway.
 *
 * An IP host is refused rather than passed through: it can never be a valid rpId, and
 * failing here produces the right message instead of a raw SecurityError.
 */
export function resolveRpId(configured: string | undefined, host: string | undefined): string {
  if (configured) return configured;
  if (!host) return 'localhost';
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare) || bare.includes(':')) return 'localhost';
  return host;
}

export const RP_ID = resolveRpId(
  process.env.NEXT_PUBLIC_RP_ID,
  typeof location === 'undefined' ? undefined : location.hostname,
);

export {
  classifySignInError,
  messageForSignInError,
  PRF_UNAVAILABLE_MESSAGE,
  type SignInFailure,
} from './signInError';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [account, setAccount] = useState<MeraAccount | undefined>();
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly StoredAccount[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<SignInFailure | undefined>();
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<SigningSession | undefined>();

  useEffect(() => {
    let stored: string | null = null;
    let storedAccounts: readonly StoredAccount[] = [];
    try {
      stored = window.localStorage.getItem(CREDENTIAL_STORAGE_KEY);
      storedAccounts = readStoredAccounts(window.localStorage.getItem(ACCOUNTS_STORAGE_KEY));
    } catch {
      stored = null;
    }
    setCredentialId(stored);
    setAccounts(storedAccounts);
    setStatus(stored ? 'returning' : 'new');
  }, []);

  const adopt = useCallback(
    (result: MeraAccount) => {
      const nextAccounts = withStoredAccount(accounts, {
        credentialId: result.credentialId,
        address: result.address,
      });
      try {
        window.localStorage.setItem(CREDENTIAL_STORAGE_KEY, result.credentialId);
        window.localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(nextAccounts));
      } catch {
        // A browser with storage blocked still works; the user signs in each visit.
      }
      setCredentialId(result.credentialId);
      setAccounts(nextAccounts);
      setAccount(result);
      setStatus('signed-in');
      setSession({ device: 'This browser', startedAt: Date.now() });
    },
    [accounts],
  );

  /**
   * One place where a failed ceremony becomes a message. A `SecurityError` also goes
   * to the console with the origin and rpId in it, because that one is a deployment
   * mistake the user cannot act on and the developer needs the detail for.
   */
  const report = useCallback((caught: unknown) => {
    const kind = classifySignInError(caught);
    setFailure(kind);
    setError(messageForSignInError(caught));
    if (shouldLogToConsole(kind)) {
      console.error(
        developerNoteFor(kind, RP_ID, typeof location === 'undefined' ? '' : location.origin),
        caught,
      );
    }
  }, []);

  const create = useCallback(
    async (where: PasskeyLocation = 'any') => {
      setBusy(true);
      setError(undefined);
      setFailure(undefined);
      try {
        adopt(await createAccount({ rp: { id: RP_ID, name: 'MoneyMarkets' }, where }));
      } catch (caught) {
        report(caught);
      } finally {
        setBusy(false);
      }
    },
    [adopt, report],
  );

  const authenticate = useCallback(
    async (where: PasskeyLocation = 'any', targetCredentialId?: string) => {
      setBusy(true);
      setError(undefined);
      setFailure(undefined);
      // A specific target (from "Switch account") wins; otherwise the last account
      // used on this device, when one is remembered; otherwise the browser is left
      // to offer whatever discoverable passkey it finds for this rpId.
      const cred = targetCredentialId ?? credentialId;
      try {
        adopt(await signIn({ rpId: RP_ID, where, ...(cred ? { credentialId: cred } : {}) }));
      } catch (caught) {
        report(caught);
      } finally {
        setBusy(false);
      }
    },
    [adopt, credentialId, report],
  );

  const endSession = useCallback(() => {
    setAccount(undefined);
    setSession(undefined);
    setStatus(credentialId ? 'returning' : 'new');
  }, [credentialId]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      ...(account ? { account } : {}),
      credentialId,
      accounts,
      ...(error ? { error } : {}),
      ...(failure ? { failure } : {}),
      busy,
      ...(session ? { session } : {}),
      create,
      authenticate,
      endSession,
    }),
    [
      status,
      accounts,
      account,
      credentialId,
      error,
      failure,
      busy,
      session,
      create,
      authenticate,
      endSession,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
