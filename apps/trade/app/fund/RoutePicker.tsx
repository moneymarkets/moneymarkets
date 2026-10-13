'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import { Button, CheckIcon, Chip, Notice, Skeleton } from '@tradepro/ui';
import { apiUrl } from '../../lib/basePath';
import { formatMoney, parseAmount } from '../../lib/format';
import { useSourceWallet } from '../../lib/wallet/useSourceWallet';
import { sendSourceTx, wasRejectedByUser } from '../../lib/wallet/evm';
import { readLastSenderAddress, saveLastSenderAddress, senderAddressError } from '../../lib/fund/senderAddressBook';
import { SourceWalletCard } from '../../components/SourceWalletCard';
import { DepositProgress } from '../../components/DepositProgress';
import type { TicketState as MoveState } from '../../lib/ticket';
import { upstreamLine } from '../../lib/upstream';

/**
 * "Bring it from another chain" — asset, then chain, then amount, then the route.
 *
 * ## Why this replaced five vendor tiles
 *
 * The old screen asked "where is your money now?" and answered with five tiles named
 * after vendors' routes, hardcoded, each its own quote flow. Two things were wrong with
 * it. A user does not think in vendors, they think *I have USDC on Base*. And a
 * hardcoded tile is a promise the app cannot keep — when the solver network began
 * refusing every amount under $1,000, four of the five tiles were still offered as
 * though nothing had changed.
 *
 * So: the chips and tiles come from `/api/fund/coverage`, which is the union of what
 * the rails themselves say they carry. Nothing renders that no rail claims. And the
 * route card is populated by `/api/fund/route`, which asks every eligible rail in
 * parallel and returns what each one actually said — including the refusals, in the
 * vendor's own words.
 *
 * ## The default path never asks for a wallet
 *
 * "Best" is always a deposit-address rail — Relay or NEAR Intents. The user sends from
 * wherever their money already is: no extension, no signature, no gas on the source
 * chain. That is the whole premise of this product, and a rail that needs a browser
 * wallet is a different product wearing the same card.
 *
 * The wallet-signed rails are real, often cheaper, and kept — behind a section the user
 * opens deliberately, each labelled with the chain it wants a signature on. CCTP prices
 * Base USDC about 0.4% better than Relay and still does not lead, because that 0.4%
 * costs a wallet the user may not have.
 *
 * **Nothing on the default path renders a connect button.** `SourceWalletCard` lives
 * inside the collapsed section and nowhere else, so a user who never opens it is never
 * asked to connect anything.
 *
 * ## Declines are shown, not hidden
 *
 * A rail that refuses appears under "Not available", named, with its own sentence. A
 * vendor that says "minimum swap amount is $1,000" has told the user something they can
 * act on; "no route found" has not. That is also why deBridge and Mayan appear here at
 * all — they were checked, they do not carry Monad, and saying so with the date is more
 * useful than an absence the reader has to interpret.
 */

interface CoverageEntry {
  asset: string;
  chainId: number;
  chainKey: string;
  chainName: string;
  vm: 'evm' | 'svm' | 'tvm' | 'btc';
  assetAddress: string;
  assetDecimals: number;
  rails: string[];
  delivers: 'USDC' | 'USDT0';
}

interface WireQuote {
  rail: string;
  amountIn: string;
  amountOut: string;
  outToken: string;
  /** The destination token's own decimals — never the source asset's. */
  outDecimals: number;
  fees: { label: string; amount: string; token: string; usd?: string }[];
  etaSeconds: number;
  expiresAt: number;
  landsIn: 'wallet' | 'margin';
  executable: boolean;
  /** True where acting on this quote needs a source-chain signature. */
  needsWallet: boolean;
}

interface DepositInstructionWire {
  rail: string;
  address: string;
  chainName: string;
  assetSymbol: string;
  assetDecimals: number;
  amount: string;
  amountOut: string;
  outToken: string;
  outTokenAddress: string | null;
  outDecimals: number;
  etaSeconds: number;
  expiresAt: number;
  refundAddressRequired: boolean;
  ref: string | null;
}

interface PlanStep {
  chainId: number;
  to: string;
  data: string;
  value: string;
  label: string;
}

interface SigningPlanWire {
  kind: 'wallet-signed';
  rail: string;
  chainId: number;
  chainName: string;
  assetSymbol: string;
  assetDecimals: number;
  amount: string;
  amountOut: string;
  outToken: string;
  etaSeconds: number;
  txs: PlanStep[];
  simulation: { label: string; verdict: 'ok' | 'reverted' | 'unknown'; reason?: string }[];
}

interface RouteResponse {
  best: WireQuote | null;
  alternatives: WireQuote[];
  declines: { rail: string; reason: string }[];
  silent: { rail: string; reason: string }[];
}

/** The vendor's name as it should appear beside its own price or refusal. */
const RAIL_NAME: Record<string, string> = {
  relay: 'Relay',
  across: 'Across',
  cctp: 'Circle CCTP',
  'oft-ausd': 'Agora AUSD bridge',
  'oft-usdt0': 'USDT0 bridge',
  near: 'NEAR Intents',
  debridge: 'deBridge',
  mayan: 'Mayan',
};

/** One line each, so a user choosing between two vendors knows what differs. */
const RAIL_EXPLAINER: Record<string, string> = {
  relay: 'A solver delivers on Monad in seconds, and refunds you if it cannot.',
  across: 'Relayers fill your deposit on Monad, usually in a few seconds.',
  cctp: 'Your USDC is burned on the source chain and minted on Monad by Circle.',
  near: 'A solver network routes your deposit and delivers on Monad.',
};

const railName = (id: string) => RAIL_NAME[id] ?? id;

/** Joins class names, skipping falsy ones — same helper shape as packages/ui's own. */
function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * What a wallet-signed rail actually needs, said before the user opens their wallet.
 *
 * Built from the quote's own fee list rather than from a table of assumptions: a fee
 * denominated in something other than the asset being sent is a fee paid in the chain's
 * gas token, which is money the user must already hold there **on top of** the transfer.
 * deBridge charges 0.001 ETH that way and the OFT rails charge a LayerZero message fee;
 * both are invisible in the headline number and neither is small on a $5 deposit.
 *
 * Naming the token as well as the chain matters for the OFT rails in particular: they
 * carry AUSD and USDT specifically, so "a wallet on Base" is not enough to tell someone
 * whether they can use it.
 */
function walletRequirement(quote: WireQuote, entry: CoverageEntry): string {
  const nativeFee = quote.fees.find((f) => f.token && f.token !== entry.asset);
  const holding = `a wallet holding ${entry.asset} on ${entry.chainName}`;
  const gas = nativeFee
    ? `, plus ${nativeFee.token} on ${entry.chainName} for the fee and the gas`
    : `, plus ${entry.chainName} gas`;
  return `Requires ${holding}${gas}`;
}


export function RoutePicker({
  account,
  moveState,
  moveTxHash,
  onGoToMove,
}: {
  account: Address;
  /** The move's own ticket state, lifted out of `TopUpCard` by `FundScreen` — passed
   * straight through to `DepositProgress` so its last two steps read a real
   * transaction and a real margin balance, not the swap's own status. */
  moveState?: MoveState | undefined;
  /** The move transaction's own hash, once known — the tracker's step-5 evidence. */
  moveTxHash?: string | undefined;
  /**
   * Switches the Add money page to its "From my wallet" tab, so the tracker's own
   * "Move to your trading balance" button lands somewhere the user can see it act.
   * Purely a tab switch — `requestMove` below still fires the same cross-tab signal
   * it always has, for whatever else listens.
   */
  onGoToMove?: () => void;
}) {
  const [coverage, setCoverage] = useState<CoverageEntry[] | undefined>();
  const [coverageFailed, setCoverageFailed] = useState(false);
  const [unverified, setUnverified] = useState<string[]>([]);

  const [asset, setAsset] = useState<string | undefined>();
  const [chainId, setChainId] = useState<number | undefined>();
  const [amountInput, setAmountInput] = useState('');

  const [routing, setRouting] = useState(false);
  const [result, setResult] = useState<RouteResponse | undefined>();
  const [routeError, setRouteError] = useState<string | undefined>();
  const [issuing, setIssuing] = useState(false);
  const [instruction, setInstruction] = useState<DepositInstructionWire | undefined>();
  const [plan, setPlan] = useState<SigningPlanWire | undefined>();
  /** Which step of the plan is being signed, and what has landed so far. */
  const [signingStep, setSigningStep] = useState<number | undefined>();
  const [signedHashes, setSignedHashes] = useState<string[]>([]);
  const [executeError, setExecuteError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  /**
   * The wallet-signed section, shut until the user opens it.
   *
   * Collapsed is the honest default: those rails need something the user may not have,
   * and opening the section is how they say they have it.
   */
  const [walletSectionOpen, setWalletSectionOpen] = useState(false);
  /**
   * The address the money will leave from, asked for **only** on non-EVM chains.
   *
   * Relay validates `user` against the origin chain, so an EVM address on a Solana or
   * Tron origin is rejected outright: "Invalid address 0x714f… for chain 728126428".
   * On an EVM origin the signed-in account is a valid address there, so nothing is
   * asked. This is a field the vendor genuinely requires — unlike the refund address
   * an earlier reading thought Tron needed, which it does not.
   *
   * Prefilled once per chain from what was saved last time (D202) — never from the
   * connected wallet. Nothing writes to this field again while the user is on the
   * page: clearing it stays cleared, typing over it stays typed.
   */
  const [senderAddress, setSenderAddress] = useState('');
  const [senderTouched, setSenderTouched] = useState(false);
  /** The chain this field was last prefilled for — prefill fires once per chain, not
   * on every render, and not again just because `senderAddress` changed (D202). */
  const prefilledChainRef = useRef<string | undefined>(undefined);

  /** The wallet the money leaves from, for the wallet-signed rails further down —
   * a second, separate signer from the passkey account, which never signs on a
   * source chain and never could. */
  const wallet = useSourceWallet();
  const connectedAddress = wallet.address;

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl('/api/fund/coverage'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { entries: CoverageEntry[]; unverifiedRails?: string[] }) => {
        if (cancelled) return;
        setCoverage(body.entries);
        setUnverified(body.unverifiedRails ?? []);
      })
      .catch(() => {
        if (!cancelled) setCoverageFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const assets = useMemo(
    () => [...new Set((coverage ?? []).map((e) => e.asset))].sort(),
    [coverage],
  );
  const chains = useMemo(
    () => (coverage ?? []).filter((e) => e.asset === asset),
    [coverage, asset],
  );
  const entry = useMemo(
    () => chains.find((e) => e.chainId === chainId),
    [chains, chainId],
  );

  useEffect(() => {
    // Fires once per chain, the first time its field appears — never again for that
    // chain, and never because `senderAddress` itself changed. That second part is
    // the fix: the old effect had `senderAddress` as both its guard and its
    // dependency, so clearing the field re-ran it and refilled it immediately (D202).
    if (!entry || entry.vm === 'evm') return;
    if (prefilledChainRef.current === entry.chainKey) return;
    prefilledChainRef.current = entry.chainKey;
    setSenderAddress(readLastSenderAddress(account, entry.chainKey) ?? '');
    setSenderTouched(false);
  }, [entry, account]);

  const amount = entry ? parseAmount(amountInput, entry.assetDecimals) : undefined;
  /** What actually goes to the vendor: what was typed, or the connected wallet. */
  const effectiveSender = senderAddress.trim() || connectedAddress || '';
  const senderError =
    entry && entry.vm !== 'evm' ? senderAddressError(entry.vm, senderAddress) : undefined;

  /**
   * The two groups. The router already sorts deposit-address rails first, so this is a
   * partition of an ordered list rather than a re-ranking — the card never disagrees
   * with the router about which rail is best.
   */
  const ranked = result ? [result.best, ...result.alternatives].filter((q): q is WireQuote => Boolean(q)) : [];
  const noWalletQuotes = ranked.filter((q) => !q.needsWallet);
  const walletQuotes = ranked.filter((q) => q.needsWallet);
  const best = noWalletQuotes[0] ?? walletQuotes[0];
  const otherNoWallet = noWalletQuotes.slice(best && !best.needsWallet ? 1 : 0);
  /** True only when no deposit-address rail quoted at all — item 1.3. */
  const bestNeedsWallet = Boolean(best?.needsWallet);

  async function findRoute() {
    if (!entry || amount === undefined || amount <= 0n) return;
    // Saved only here, on a deliberate submit, and only once it has a shape the
    // chain it names would accept — never on every keystroke (D202).
    if (entry.vm !== 'evm' && effectiveSender !== '' && !senderAddressError(entry.vm, effectiveSender)) {
      saveLastSenderAddress(account, entry.chainKey, effectiveSender);
    }
    setRouting(true);
    setResult(undefined);
    setRouteError(undefined);
    try {
      const res = await fetch(apiUrl('/api/fund/route'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          recipient: account,
          chainId: entry.chainId,
          chainKey: entry.chainKey,
          chainName: entry.chainName,
          vm: entry.vm,
          assetSymbol: entry.asset,
          assetAddress: entry.assetAddress,
          assetDecimals: entry.assetDecimals,
          amount: amount.toString(),
          // Relay validates `user` against the origin chain and NEAR Intents needs a
          // refund address there — both at quote time, not only at execute time. A
          // quote asked without it comes back as a refusal that reads like a closed
          // route.
          ...(entry.vm === 'evm' || effectiveSender === '' ? {} : { senderAddress: effectiveSender }),
          wantsMargin: false,
        }),
      });
      const body = (await res.json()) as RouteResponse & {
        upstream?: { source?: string; message?: string };
      };
      if (!res.ok) {
        setRouteError(
          body.upstream?.message
            ? upstreamLine({ source: body.upstream.source ?? 'The routing service', message: body.upstream.message })
            : `The routing service answered ${res.status}.`,
        );
        return;
      }
      setResult(body);
    } catch {
      setRouteError('The routing service could not be reached.');
    } finally {
      setRouting(false);
    }
  }

  async function getAddressFor(rail: string) {
    if (!entry || amount === undefined) return;
    setIssuing(true);
    setInstruction(undefined);
    setPlan(undefined);
    setSignedHashes([]);
    setSigningStep(undefined);
    setExecuteError(undefined);
    setCopied(false);
    try {
      const res = await fetch(apiUrl('/api/fund/execute'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          rail,
          recipient: account,
          chainId: entry.chainId,
          chainKey: entry.chainKey,
          chainName: entry.chainName,
          vm: entry.vm,
          assetSymbol: entry.asset,
          assetAddress: entry.assetAddress,
          assetDecimals: entry.assetDecimals,
          amount: amount.toString(),
          ...(entry.vm === 'evm' ? {} : { senderAddress: effectiveSender }),
        }),
      });
      const body = (await res.json()) as (DepositInstructionWire | SigningPlanWire) & {
        error?: string;
        reason?: string;
        step?: string;
        upstream?: { source?: string; message?: string };
      };
      if (!res.ok) {
        // The vendor's own words, or the chain's. Source-named, never softened — a
        // screening refusal and a revert reason both arrive intact.
        setExecuteError(
          body.upstream?.message
            ? upstreamLine({ source: body.upstream.source ?? railName(rail), message: body.upstream.message })
            : body.error === 'WOULD_REVERT'
              ? `The network refused “${body.step ?? 'this step'}”: ${body.reason ?? 'no reason given'}`
              : (body.reason ?? `${railName(rail)} could not issue an address.`),
        );
        return;
      }
      if ((body as SigningPlanWire).kind === 'wallet-signed') {
        setPlan(body as SigningPlanWire);
      } else {
        setInstruction(body as DepositInstructionWire);
      }
    } catch {
      setExecuteError('The funding service could not be reached.');
    } finally {
      setIssuing(false);
    }
  }

  /**
   * Sign the plan, one transaction at a time, in the order the rail gave them.
   *
   * Order is not cosmetic: an approval must be mined before the transfer that spends it,
   * and a USDT allowance reset must be mined before the approval that replaces it. So
   * each is sent and awaited in turn, and a rejection stops the sequence where it
   * happened rather than pushing on to a step that would certainly revert.
   *
   * The chain is re-asserted immediately before every send inside `sendSourceTx`. A user
   * can switch networks in their wallet between two approvals, and a deposit sent to a
   * SpokePool address on the wrong chain is money handed to whatever lives there instead.
   */
  async function signPlan() {
    if (!plan || wallet.state.status !== 'evm') return;
    setExecuteError(undefined);
    const onChain = await wallet.ensureChain(plan.chainId);
    if (!onChain) return;

    // Collected locally as well as in state: `setSignedHashes` does not apply until the
    // next render, and the burn must be recorded with the hash from this run.
    const hashes = [...signedHashes];

    for (let i = signedHashes.length; i < plan.txs.length; i += 1) {
      const step = plan.txs[i];
      if (!step) break;
      setSigningStep(i);
      try {
        const hash = await sendSourceTx(wallet.state.wallet, plan.chainId, {
          to: step.to as `0x${string}`,
          data: step.data as `0x${string}`,
          value: step.value,
        });
        hashes.push(hash);
        setSignedHashes((h) => [...h, hash]);
      } catch (e) {
        setSigningStep(undefined);
        setExecuteError(
          wasRejectedByUser(e)
            ? `You cancelled “${step.label}”. Nothing after it was sent.`
            : e instanceof Error
              ? e.message.split('\n')[0]
              : 'That transaction could not be sent.',
        );
        return;
      }
    }
    setSigningStep(undefined);

    /**
     * Record the burn so the watcher can finish it.
     *
     * A deposit-address rail records itself server-side, because the server issues the
     * address. A wallet-signed one has no such moment: the user signs in their own
     * wallet and the server never learns of it unless this says so. For CCTP that
     * matters more than for the others — the mint on Monad is the relayer's to submit,
     * and a burn nobody records is money burned with nobody to complete it.
     *
     * The last transaction is the burn; the ones before it are approvals.
     */
    if (plan.rail === 'cctp' && entry) {
      const burnHash = hashes.at(-1);
      if (burnHash) {
        try {
          await fetch(apiUrl('/api/fund/burn'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              rail: 'cctp',
              recipient: account,
              chainId: plan.chainId,
              chainName: plan.chainName,
              assetSymbol: plan.assetSymbol,
              assetDecimals: plan.assetDecimals,
              amount: plan.amount,
              txHash: burnHash,
            }),
          });
        } catch {
          // The burn is on chain either way. What is lost is the automatic mint, and the
          // line below is what tells the user that rather than leaving them to find out.
          setExecuteError(
            'Your burn went through, but this app could not record it, so the mint on ' +
              'Monad will not happen automatically. Keep this page and tell us the ' +
              'transaction hash.',
          );
        }
      }
    }
  }

  if (coverageFailed) {
    return (
      <div className="pg-fund-pane">
        <Notice tone="warn">
          The list of chains we can bring money from could not be read, so none is shown.
          It is read live from each bridge rather than written down here, and an old
          list would offer you a route that may not exist.
        </Notice>
      </div>
    );
  }

  if (!coverage) {
    return (
      <div className="pg-fund-pane">
        <Skeleton rows={3} />
      </div>
    );
  }

  const step1Done = Boolean(asset);
  const step2Done = Boolean(entry);
  const step3Done = Boolean(result);

  return (
    <div className="pg-fund-pane">
      <p className="tiny muted" style={{ marginTop: 0 }}>
        Every chain below is one a bridge told us it carries to Monad today.
      </p>

      <ol className="steps pg-fund-steps">
        {/* 1 — what do you have */}
        <li className={step1Done ? 'step done' : 'step active'}>
          <span className="dot">{step1Done ? <CheckIcon /> : '1'}</span>
          <div>
            <span className="lbl">What do you have?</span>
            <div className="filters" style={{ marginTop: 8 }}>
              {assets.map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={asset === a}
                  onClick={() => {
                    setAsset(a);
                    setChainId(undefined);
                    setResult(undefined);
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </li>

        {/* 2 — where is it */}
        <li
          className={cx(
            'step',
            !step1Done && 'locked',
            step1Done && step2Done && 'done',
            step1Done && !step2Done && 'active',
          )}
        >
          <span className="dot">{step1Done && step2Done ? <CheckIcon /> : '2'}</span>
          <div>
            <span className="lbl">Which chain is it on?</span>
            {asset ? (
              <>
                <div className="filters" style={{ marginTop: 8 }}>
                  {chains.map((c) => (
                    <button
                      key={c.chainId}
                      type="button"
                      aria-pressed={chainId === c.chainId}
                      onClick={() => {
                        setChainId(c.chainId);
                        setResult(undefined);
                      }}
                    >
                      {c.chainName}
                    </button>
                  ))}
                </div>
                {unverified.length > 0 ? (
                  <p className="tiny muted" style={{ marginTop: 8 }}>
                    {unverified.map(railName).join(', ')} could not confirm its routes just now,
                    so its chains are shown from the last confirmed list.
                  </p>
                ) : null}
              </>
            ) : (
              <span className="sub">Choose what you have above first.</span>
            )}
          </div>
        </li>

        {/* 3 — how much */}
        <li
          className={cx(
            'step',
            !step2Done && 'locked',
            step2Done && step3Done && 'done',
            step2Done && !step3Done && 'active',
          )}
        >
          <span className="dot">{step2Done && step3Done ? <CheckIcon /> : '3'}</span>
          <div>
            <span className="lbl">How much?</span>
            {entry ? (
              <>
                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor="rail-amount">Amount in {entry.asset}</label>
                  <input
                    id="rail-amount"
                    className="num"
                    inputMode="decimal"
                    value={amountInput}
                    onChange={(e) => {
                      setAmountInput(e.target.value);
                      setResult(undefined);
                    }}
                  />
                </div>
                <p className="tiny muted" style={{ marginTop: 6 }}>
                  No minimum is applied here. If a bridge has one, it tells you in its own words.
                </p>

                {/*
                  Asked for on non-EVM origins only, and it is a text field rather than a
                  wallet connection on purpose.

                  Relay validates `user` against the origin chain and NEAR Intents needs
                  somewhere on it to return a failed deposit to, so both genuinely need this
                  address before they will issue anything. Typing an address is not connecting
                  a wallet: no extension, no signature, no permission granted. The connect
                  buttons live in the wallet section further down and nowhere else (item 1.2).
                */}
                {entry.vm !== 'evm' ? (
                  <div className="field" style={{ marginTop: 12 }}>
                    <label htmlFor="rail-sender">
                      Your {entry.chainName} address, the one you will send from
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        id="rail-sender"
                        value={senderAddress}
                        onChange={(e) => {
                          setSenderAddress(e.target.value);
                          setSenderTouched(true);
                        }}
                        style={{ paddingRight: senderAddress ? 32 : undefined }}
                      />
                      {senderAddress ? (
                        <button
                          type="button"
                          aria-label="Clear address"
                          onClick={() => {
                            setSenderAddress('');
                            setSenderTouched(true);
                          }}
                          style={{
                            position: 'absolute',
                            right: 8,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 0,
                            padding: 4,
                            cursor: 'pointer',
                            color: 'inherit',
                            opacity: 0.6,
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    {senderTouched && senderError ? (
                      <p className="tiny" style={{ marginTop: 6, color: 'var(--down)' }}>
                        {senderError}
                      </p>
                    ) : (
                      <p className="tiny muted" style={{ marginTop: 6 }}>
                        A bridge needs an address on {entry.chainName} before it will issue a
                        deposit address there — Relay validates who is sending, and NEAR Intents
                        needs somewhere on {entry.chainName} to return a failed deposit to. Your
                        money still arrives in this account, and nothing here can send it
                        anywhere else.
                      </p>
                    )}
                  </div>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <Button
                    variant="primary"
                    block
                    disabled={
                      amount === undefined ||
                      amount <= 0n ||
                      routing ||
                      Boolean(entry.vm !== 'evm' && senderError)
                    }
                    disabledLabel={
                      routing
                        ? 'Asking every bridge'
                        : entry.vm !== 'evm' && senderError
                          ? senderError
                          : 'Enter an amount'
                    }
                    onClick={() => void findRoute()}
                  >
                    Find the best route
                  </Button>
                </div>
              </>
            ) : (
              <span className="sub">Choose a chain above first.</span>
            )}
          </div>
        </li>
      </ol>

      {/* 4 — the route */}
      {routeError ? (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">{routeError}</Notice>
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          {/*
            Item 1.3: when no deposit-address rail would carry this, say so in their
            words first. The wallet-signed section below is then offered — the user opens
            it if they have a wallet — rather than a connect prompt appearing uninvited.
          */}
          {bestNeedsWallet ? (
            <div style={{ marginBottom: 12 }}>
              <Notice tone="warn">
                Neither Relay nor NEAR Intents will carry this right now, and those are the
                two that need nothing but an address to send to. Their reasons are below.
                If you have a wallet on {entry?.chainName}, the other bridges can still do
                it — open &ldquo;Other ways&rdquo;.
              </Notice>
            </div>
          ) : null}

          {best && entry && !bestNeedsWallet ? (
            <>
              <div className="between">
                <span className="small" style={{ fontWeight: 600 }}>
                  Best: via {railName(best.rail)}
                </span>
                <Chip tone="up">
                  {formatMoney(BigInt(best.amountOut), best.outDecimals, 6)} {best.outToken} on
                  Monad
                </Chip>
              </div>
              <p className="tiny muted" style={{ marginTop: 4 }}>
                {RAIL_EXPLAINER[best.rail] ?? ''}
              </p>
              <p className="tiny" style={{ marginTop: 4, color: 'var(--up)' }}>
                No wallet needed. Send from wherever your {entry.asset} already is.
              </p>
              <div className="between tiny" style={{ marginTop: 8 }}>
                <span className="muted">Arrives in about</span>
                <span>{best.etaSeconds} seconds</span>
              </div>
              {best.fees.map((f) => (
                <div className="between tiny" key={f.label}>
                  <span className="muted">
                    {railName(best.rail)} fee, {f.label}
                  </span>
                  <span className="num">
                    {formatMoney(BigInt(f.amount), entry.assetDecimals, 6)} {f.token || entry.asset}
                  </span>
                </div>
              ))}
              <div className="between tiny" style={{ marginTop: 4 }}>
                <span className="muted">Lands in</span>
                <span>
                  {best.landsIn === 'margin' ? 'your trading balance' : 'your wallet, then Move'}
                </span>
              </div>

              {/*
                Which of the two meanings this field has depends on which rail wins, and
                that is only known now — so the warning is written here, not on the field
                itself, which is shown before any rail is chosen (section 2 of the D202
                report).
              */}
              {entry.vm !== 'evm' && best.rail === 'relay' ? (
                <p className="tiny" style={{ marginTop: 8, color: 'var(--warn)' }}>
                  Relay credits this by who sent it. Send from the exact address entered
                  above — a different wallet may not be credited.
                </p>
              ) : null}
              {entry.vm !== 'evm' && best.rail === 'near' ? (
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  NEAR Intents only uses the address above to refund a failed deposit. You
                  can send from any wallet.
                </p>
              ) : null}

              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  block
                  disabled={
                    issuing ||
                    (entry.vm !== 'evm' && (effectiveSender === '' || Boolean(senderError)))
                  }
                  disabledLabel={
                    issuing
                      ? `Asking ${railName(best.rail)} for an address`
                      : senderError || `Enter your ${entry.chainName} address above`
                  }
                  onClick={() => void getAddressFor(best.rail)}
                >
                  Continue with {railName(best.rail)}
                </Button>
              </div>
            </>
          ) : null}

          {executeError ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn">{executeError}</Notice>
            </div>
          ) : null}

          {/*
            The deposit address. Nothing on this path touches a wallet: the user sends
            from wherever their money already is, which is the whole point of it.
          */}
          {instruction ? (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <p className="small" style={{ margin: 0, fontWeight: 600 }}>
                Send {formatMoney(BigInt(instruction.amount), instruction.assetDecimals, 6)}{' '}
                {instruction.assetSymbol} on {instruction.chainName}
              </p>
              <p className="tiny muted" style={{ marginTop: 4 }}>
                via {railName(instruction.rail)}. Send this exact amount to this address.
              </p>
              <div className="addr" style={{ marginTop: 10, wordBreak: 'break-all' }}>
                {instruction.address}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(instruction.address)
                      .then(() => setCopied(true))
                      .catch(() => undefined);
                  }}
                >
                  {copied ? 'Copied' : 'Copy address'}
                </Button>
              </div>
              <div className="between tiny" style={{ marginTop: 10 }}>
                <span className="muted">You receive</span>
                <span className="num">
                  {formatMoney(BigInt(instruction.amountOut), instruction.outDecimals, 6)} {instruction.outToken} on Monad
                </span>
              </div>
              <div className="between tiny">
                <span className="muted">Arrives in about</span>
                <span>{instruction.etaSeconds} seconds after it confirms</span>
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Sending a different amount is fine, and {railName(instruction.rail)} will price
                it when it arrives. Nothing here can move money out of your account.
              </p>

              {/* Live, from the watcher's own row: seen on the source chain, then the
                  vendor's own status, then the Monad transaction when it lands. */}
              <DepositProgress
                depositAddress={instruction.address}
                landsIn={best?.landsIn ?? 'wallet'}
                outToken={instruction.outToken}
                outTokenAddress={instruction.outTokenAddress}
                chainName={instruction.chainName}
                etaSeconds={instruction.etaSeconds}
                address={account}
                moveState={moveState}
                moveTxHash={moveTxHash}
                {...(onGoToMove ? { onMoveRequested: onGoToMove } : {})}
              />
            </div>
          ) : null}

          {/* Other deposit-address rails: still no wallet, just a worse number.
              Hidden once a deposit is in flight — an alternative route belongs before
              Continue, not competing for attention under a tracker that is already
              watching a real address. */}
          {!instruction && otherNoWallet.length > 0 && entry ? (
            <div style={{ marginTop: 14 }}>
              <p className="tiny muted" style={{ marginBottom: 6 }}>
                Also without a wallet
              </p>
              {otherNoWallet.map((q) => (
                <div className="between tiny" key={q.rail} style={{ marginTop: 4 }}>
                  <span>via {railName(q.rail)}</span>
                  <span className="num">
                    {formatMoney(BigInt(q.amountOut), q.outDecimals, 6)} {q.outToken} on
                    Monad, {q.etaSeconds}s
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {result.declines.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <p className="tiny muted" style={{ marginBottom: 6 }}>
                Not available
              </p>
              {result.declines.map((d) => (
                <p className="tiny" key={d.rail} style={{ marginTop: 4 }}>
                  <b>{railName(d.rail)}</b> said: &ldquo;{d.reason}&rdquo;
                </p>
              ))}
            </div>
          ) : null}

          {/*
            ── The wallet-signed section ──────────────────────────────────────────────
            Shut by default and opened on purpose. Everything that asks for a wallet is
            inside here: the connect buttons, the quotes that need a signature, and the
            signing plan. A user who never opens this is never asked to connect anything
            (items 1.1 and 1.2).
          */}
          {!instruction && walletQuotes.length > 0 && entry ? (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <button
                type="button"
                onClick={() => setWalletSectionOpen((open) => !open)}
                aria-expanded={walletSectionOpen}
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <span className="small" style={{ fontWeight: 600 }}>
                  {walletSectionOpen ? '▾' : '▸'} Other ways, if you have a wallet connected
                </span>
                <span className="tiny muted" style={{ display: 'block', marginTop: 2 }}>
                  {walletQuotes.length} more {walletQuotes.length === 1 ? 'bridge' : 'bridges'},
                  each needing a wallet holding {entry.asset} on {entry.chainName} and gas
                  there. Often cheaper, never required.
                </span>
              </button>

              {walletSectionOpen ? (
                <div style={{ marginTop: 12 }}>
                  <SourceWalletCard
                    wallet={wallet}
                    recipient={account}
                    chainName={entry.chainName}
                    vm={entry.vm}
                    chainIds={[entry.chainId]}
                  />

                  <div style={{ marginTop: 12 }}>
                    {walletQuotes.map((q) => (
                      <div key={q.rail} style={{ marginTop: 10 }}>
                        <div className="between">
                          <span className="small">via {railName(q.rail)}</span>
                          <span className="num small">
                            {formatMoney(BigInt(q.amountOut), q.outDecimals, 6)} {q.outToken}{' '}
                            on Monad
                          </span>
                        </div>
                        <p className="tiny muted" style={{ margin: '2px 0 0' }}>
                          {walletRequirement(q, entry)}
                          {q.executable ? '' : '. This app cannot build its transaction yet'}
                        </p>
                        {q.executable ? (
                          <div style={{ marginTop: 6 }}>
                            <Button
                              size="sm"
                              variant="soft"
                              disabled={issuing || wallet.state.status !== 'evm'}
                              disabledLabel={
                                issuing ? 'Asking the bridge' : 'Connect a wallet above first'
                              }
                              onClick={() => void getAddressFor(q.rail)}
                            >
                              Use {railName(q.rail)}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  {/*
                    The signing plan. Every step is named and every one was checked with
                    `eth_call` before it got here — a step the chain would refuse never
                    reaches this list, and a step that could not be checked says so
                    rather than claiming a pass it did not earn.
                  */}
                  {plan ? (
                    <div
                      style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}
                    >
                      <p className="small" style={{ margin: 0, fontWeight: 600 }}>
                        {plan.txs.length === 1
                          ? 'One transaction to sign'
                          : `${plan.txs.length} transactions to sign, in order`}
                      </p>
                      <p className="tiny muted" style={{ marginTop: 4 }}>
                        via {railName(plan.rail)} on {plan.chainName}. You pay the gas on{' '}
                        {plan.chainName}; Monad gas is on us.
                      </p>

                      <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                        {plan.txs.map((step, i) => {
                          const done = i < signedHashes.length;
                          const active = signingStep === i;
                          const check = plan.simulation[i];
                          return (
                            <div className="between tiny" key={`${step.to}-${i}`}>
                              <span>
                                {i + 1}. {step.label}
                                {check?.verdict === 'unknown' ? (
                                  <span className="muted"> (not pre-checked)</span>
                                ) : null}
                              </span>
                              <span className={done ? '' : 'muted'}>
                                {done ? 'Signed' : active ? 'Check your wallet' : 'Waiting'}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {signedHashes.length === plan.txs.length ? (
                        <p className="tiny" style={{ marginTop: 10 }}>
                          All sent. It arrives in this account once {railName(plan.rail)} fills
                          it, and the list below will say so.
                        </p>
                      ) : (
                        <div style={{ marginTop: 12 }}>
                          <Button
                            variant="primary"
                            block
                            disabled={signingStep !== undefined || wallet.state.status !== 'evm'}
                            disabledLabel={
                              signingStep !== undefined
                                ? 'Check your wallet'
                                : 'Connect the wallet holding the money'
                            }
                            onClick={() => void signPlan()}
                          >
                            {signedHashes.length === 0
                              ? `Sign and send`
                              : `Sign the rest (${plan.txs.length - signedHashes.length} left)`}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!instruction && result.silent.length > 0 ? (
            <p className="tiny muted" style={{ marginTop: 10 }}>
              {result.silent.map((s) => railName(s.rail)).join(', ')} did not answer in time.
            </p>
          ) : null}

          {!best && result.declines.length === 0 ? (
            <Notice tone="warn">No bridge answered for this amount.</Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
