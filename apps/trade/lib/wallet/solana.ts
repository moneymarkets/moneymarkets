'use client';

/**
 * The Solana source wallet — Phantom, or anything that injects the same shape.
 *
 * ## What it is for on this screen, and what it is not
 *
 * No rail this app can execute asks a Solana wallet to sign anything today. Relay and
 * NEAR Intents both fund from Solana by **issuing an address to send to**, which the
 * user pays from wherever their SOL or USDC already is — no signature, no connection.
 *
 * What they do need is the address the money will leave from: Relay validates `user`
 * against the origin chain, and NEAR Intents needs somewhere on Solana to return a
 * failed deposit to. Until now that was a text field the user had to paste into, which
 * is the one step in the flow where a typo costs a refund. Connecting the wallet fills
 * it in from the wallet itself.
 *
 * So this connector reads an address and stops there. `signAndSend` is deliberately
 * absent: there is no verified Solana transaction for it to sign, and a signing helper
 * with no caller is a path nobody has run pretending to be a feature.
 *
 * ## Why no `@solana/wallet-adapter`
 *
 * The adapter tree exists to normalise dozens of wallets and to give React context for
 * signing flows. For "tell me your public key" it is a large dependency for one string.
 * Phantom, Solflare and Backpack all expose `connect()` and `publicKey` on an injected
 * object, and the Wallet Standard registers the same wallets on `window`. If a signing
 * flow ever lands here, the adapter is the right answer then and this note is why it was
 * not the right answer now.
 */

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } }>;
  disconnect?(): Promise<void>;
}

interface SolanaWindow {
  phantom?: { solana?: SolanaProvider };
  solana?: SolanaProvider;
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
}

export interface SolanaWalletChoice {
  readonly id: string;
  readonly name: string;
  readonly provider: SolanaProvider;
}

export interface ConnectedSolanaWallet {
  readonly id: string;
  readonly name: string;
  /** Base58 public key, as the wallet gave it. Never derived or reformatted here. */
  readonly address: string;
}

/** Every injected Solana wallet this page can see. Order is discovery order. */
export function discoverSolanaWallets(): SolanaWalletChoice[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as SolanaWindow;
  const out: SolanaWalletChoice[] = [];
  const seen = new Set<SolanaProvider>();

  const add = (id: string, name: string, provider: SolanaProvider | undefined) => {
    if (!provider || seen.has(provider)) return;
    seen.add(provider);
    out.push({ id, name, provider });
  };

  add('phantom', 'Phantom', w.phantom?.solana);
  add('solflare', 'Solflare', w.solflare);
  add('backpack', 'Backpack', w.backpack);
  // The shared slot last, and only if no named wallet already claimed that object —
  // otherwise Phantom, which also sets it, would be offered twice.
  add(
    w.solana?.isPhantom ? 'phantom' : 'solana',
    w.solana?.isPhantom ? 'Phantom' : 'Solana wallet',
    w.solana,
  );
  return out;
}

/** Phantom's rejection. There is no EIP-1193 code table on this side. */
export function solanaRejectedByUser(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('user rejected') || message.includes('user denied');
}

export async function connectSolanaWallet(
  choice: SolanaWalletChoice,
): Promise<ConnectedSolanaWallet> {
  const result = await choice.provider.connect();
  // Some wallets return the key, others only set it on the provider. Both are read
  // rather than one being assumed.
  const key = result?.publicKey ?? choice.provider.publicKey;
  const address = key?.toString();
  if (!address) throw new Error('That wallet returned no address.');
  return { id: choice.id, name: choice.name, address };
}

export async function disconnectSolanaWallet(choice: SolanaWalletChoice): Promise<void> {
  try {
    await choice.provider.disconnect?.();
  } catch {
    // A wallet that will not disconnect on request is the user's to close. This app
    // forgetting the address is the part it controls, and the caller has done that.
  }
}
