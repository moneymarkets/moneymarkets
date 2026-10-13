'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { getAddress } from 'viem';
import { Button, Chip, Sheet } from '@tradepro/ui';
import { MONAD_DELEGATED_RESERVE_WEI } from '@tradepro/core';
import { apiUrl } from '../lib/basePath';
import { displayDp, formatMoney } from '../lib/format';
import type { WalletTokenEntry } from '../lib/useAccountBalances';
import { useTokenRegistry, type RegistryToken } from '../lib/useTokenRegistry';
import { maxNativeSpend, NATIVE_MON } from '../lib/wallet/swapPlan';
import { selectorList, type SelectorRow } from '../lib/wallet/tokenSelect';
import { TokenIcon } from './TokenIcon';

/**
 * The token selector (v2.1 spec 2.2): a searchable sheet (phone) / centred dialog
 * (desktop), shared by Swap, Send and the Move sheet so all three pick tokens the
 * same way. Typing filters the registry by symbol and name; pasting a full contract
 * address reads symbol and decimals FROM THE CONTRACT (`POST /api/account/tokens`,
 * the same route Settings' "Add a token" uses), adds the token to the account's own
 * set and selects it. Held tokens first, then the rest of the registry; every row
 * carries the icon (or its honest two-letter mark), symbol, name, the balance in
 * that location, the USD value where one was priced, and the "unverified" chip for
 * a token no list names.
 */

export interface PickedToken {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl: string | null;
  readonly listed: boolean;
}

export function TokenSelectorSheet({
  open,
  onClose,
  title,
  account,
  tokens,
  location,
  onPick,
  excludeNative,
  accept,
  onTokenAdded,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** "Choose a token to pay with" / "…to receive" / "…to send" (spec copy). */
  readonly title: string;
  readonly account: Address;
  readonly tokens: readonly WalletTokenEntry[];
  /** Which balance the row's figure shows: the side this pick will spend from. */
  readonly location: 'wallet' | 'trading';
  readonly onPick: (token: PickedToken) => void;
  readonly excludeNative?: boolean;
  /** Keep only rows this accepts (Move in: Kuru-traded or permit tokens). */
  readonly accept?: (row: SelectorRow) => boolean;
  /** Fired after a pasted address was added to the account's set. */
  readonly onTokenAdded?: () => void;
}) {
  const registry = useTokenRegistry();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setQuery('');
      setAddError(undefined);
    }
  }, [open]);

  const list = useMemo(
    () =>
      selectorList({
        tokens,
        registry: registry.tokens as readonly RegistryToken[],
        query,
        ...(excludeNative ? { excludeNative } : {}),
        ...(accept ? { accept } : {}),
      }),
    [tokens, registry.tokens, query, excludeNative, accept],
  );

  async function addPasted(address: string) {
    setAdding(true);
    setAddError(undefined);
    try {
      const res = await fetch(apiUrl('/api/account/tokens'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, address }),
      });
      const body = (await res.json().catch(() => undefined)) as
        | { token?: { address: string; symbol: string; name?: string; decimals: number }; error?: string }
        | undefined;
      if (!res.ok || !body?.token) {
        setAddError(
          body?.error === 'NOT_ERC20'
            ? 'That address is not an ERC-20 token contract on Monad.'
            : 'The token could not be read from its contract. Try again.',
        );
        return;
      }
      onTokenAdded?.();
      onPick({
        address: getAddress(body.token.address),
        symbol: body.token.symbol,
        name: body.token.name ?? body.token.symbol,
        decimals: body.token.decimals,
        iconUrl: null,
        listed: false,
      });
    } catch {
      setAddError('The token could not be read from its contract. Try again.');
    } finally {
      setAdding(false);
    }
  }

  function pick(row: SelectorRow) {
    onPick({
      address: getAddress(row.address),
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      iconUrl: row.iconUrl,
      listed: row.listed,
    });
  }

  const rowButton = (row: SelectorRow) => {
    const held = location === 'trading' ? row.marginValue : row.walletValue;
    const isHeld = row.walletValue > 0n || row.marginValue > 0n;
    return (
      <button
        key={row.address}
        type="button"
        className="trow"
        onClick={() => pick(row)}
      >
        <TokenIcon address={row.address} symbol={row.symbol} size={30} />
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {row.symbol}
            {row.listed ? null : <Chip tone="warn">unverified</Chip>}
          </span>
          <span className="s" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </span>
        </span>
        {isHeld ? (
          <span className="num" style={{ textAlign: 'right' }}>
            <span style={{ display: 'block', fontWeight: 600 }}>
              {formatMoney(held, row.decimals, displayDp(row.symbol, row.decimals))}
            </span>
            <span className="s" style={{ display: 'block' }}>
              {/* Item 1: a native-MON wallet row shows what's spendable, not the
                  USD line — the 10 MON reserve (D199) holds some of it back. */}
              {location === 'wallet' && row.address.toLowerCase() === NATIVE_MON.toLowerCase()
                ? `Spendable ${formatMoney(maxNativeSpend(row.walletValue, MONAD_DELEGATED_RESERVE_WEI), row.decimals, displayDp(row.symbol, row.decimals))}`
                : row.usdValue
                  ? `$${formatMoney(row.usdValue.value, row.usdValue.decimals, 2)}`
                  : 'No price'}
            </span>
          </span>
        ) : (
          <span />
        )}
      </button>
    );
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="token-selector-title">
      <h3 id="token-selector-title" style={{ margin: '0 0 8px', fontSize: 16 }}>
        {title}
      </h3>
      <div className="field" style={{ margin: 0 }}>
        <input
          className="num"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid var(--line)',
            background: 'var(--surface-2)',
            color: 'var(--ink)',
            outline: 'none',
          }}
          placeholder="Search name, symbol, or paste an address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          aria-label="Search tokens"
        />
      </div>
      <div style={{ overflowY: 'auto', maxHeight: '52vh', marginTop: 6 }}>
        {list.pastedAddress ? (
          <div
            style={{
              margin: '6px 0',
              padding: 12,
              borderRadius: 12,
              background: 'var(--accent-soft)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>Contract address pasted</div>
            <div className="tiny" style={{ wordBreak: 'break-all' }}>{list.pastedAddress}</div>
            <div className="tiny muted" style={{ margin: '4px 0 8px' }}>
              The symbol and decimals are read from the contract itself.
            </div>
            {addError ? (
              <div className="tiny" style={{ color: 'var(--down)', marginBottom: 6 }}>{addError}</div>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              disabled={adding}
              onClick={() => void addPasted(list.pastedAddress!)}
            >
              {adding ? 'Reading the contract' : 'Add this token'}
            </Button>
          </div>
        ) : null}
        {list.held.length > 0 ? (
          <>
            <div className="tiny muted" style={{ padding: '8px 2px 2px', fontWeight: 600, letterSpacing: '.02em' }}>
              YOU HOLD
            </div>
            {list.held.map(rowButton)}
          </>
        ) : null}
        {list.rest.length > 0 ? (
          <>
            <div className="tiny muted" style={{ padding: '8px 2px 2px', fontWeight: 600, letterSpacing: '.02em' }}>
              ALL TOKENS ON MONAD
            </div>
            {list.rest.map(rowButton)}
          </>
        ) : null}
        {list.held.length === 0 && list.rest.length === 0 && !list.pastedAddress ? (
          <p className="small muted" style={{ padding: '14px 2px' }}>
            No token matches. Paste a contract address to add one.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
