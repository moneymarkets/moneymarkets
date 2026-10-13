'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

/**
 * In-app notifications (ITEM 6).
 *
 * No push, no email, no permission prompt — nothing that asks the browser for
 * anything. A notification here is a line this app already knows to be true, kept
 * where the user can find it later.
 *
 * ## Fed by the watchers, not by a second set of watchers
 *
 * There is exactly one source: `recordActivity`. Every event the app can observe —
 * a receipt confirming, a resting order leaving the book, money arriving unsent —
 * already ends in an activity row, so raising the notification there means a
 * notification exists for every real event and cannot exist for anything else. A
 * second watcher would be a second thing to keep in step, and the first time they
 * disagreed the user would be told about something that never happened.
 *
 * That also settles the ordering question: the activity row is written first and the
 * notification points at it by id, so tapping one always lands on a row that exists.
 *
 * ## What it deliberately does not do
 *
 * It does not poll, it does not open a socket, and it does not fire while the tab is
 * closed. An event that happens while the user is away is noticed by the watchers on
 * their next reading and its notification is unread when they arrive — which is the
 * same outcome, without a service worker asking for permission to interrupt them.
 */

export interface AppNotification {
  /** The activity row this points at. Same id, so the two cannot drift apart. */
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly at: number;
  readonly read: boolean;
  /** Where tapping it goes. Portfolio for anything with an activity row. */
  readonly href: string;
}

const LIMIT = 50;
const CHANGED = 'tradepro:notifications';

function key(account: Address): string {
  return `tradepro.notifications.${account.toLowerCase()}`;
}

export function readNotifications(account: Address): AppNotification[] {
  try {
    const raw = window.localStorage.getItem(key(account));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is AppNotification =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as AppNotification).id === 'string' &&
        typeof (v as AppNotification).title === 'string' &&
        typeof (v as AppNotification).at === 'number',
    );
  } catch {
    return [];
  }
}

function write(account: Address, rows: readonly AppNotification[]): void {
  try {
    window.localStorage.setItem(key(account), JSON.stringify(rows.slice(0, LIMIT)));
    // Same-tab listeners: `storage` only fires in *other* tabs, so a screen that is
    // open when its own watcher writes would otherwise never re-render.
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage blocked. Notifications then cover this session only, which is honest.
  }
}

/** Idempotent on id, like the activity row it mirrors. */
export function notify(account: Address, row: Omit<AppNotification, 'read'>): void {
  const current = readNotifications(account);
  if (current.some((n) => n.id === row.id)) return;
  write(account, [{ ...row, read: false }, ...current]);
}

export function markAllRead(account: Address): void {
  const current = readNotifications(account);
  if (current.every((n) => n.read)) return;
  write(
    account,
    current.map((n) => ({ ...n, read: true })),
  );
}

export function markRead(account: Address, id: string): void {
  const current = readNotifications(account);
  write(
    account,
    current.map((n) => (n.id === id ? { ...n, read: true } : n)),
  );
}

export interface NotificationState {
  readonly rows: readonly AppNotification[];
  readonly unread: number;
  /** The newest unread one, for the toast. Undefined when everything has been seen. */
  readonly latestUnread: AppNotification | undefined;
  markAllRead: () => void;
  markRead: (id: string) => void;
}

export function useNotifications(account: Address | undefined): NotificationState {
  const [rows, setRows] = useState<readonly AppNotification[]>([]);

  useEffect(() => {
    if (!account) {
      setRows([]);
      return;
    }
    const reload = () => setRows(readNotifications(account));
    reload();
    // `storage` covers other tabs; the custom event covers this one.
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGED, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGED, reload);
    };
  }, [account]);

  const doMarkAllRead = useCallback(() => {
    if (account) markAllRead(account);
  }, [account]);
  const doMarkRead = useCallback(
    (id: string) => {
      if (account) markRead(account, id);
    },
    [account],
  );

  const unread = rows.filter((n) => !n.read).length;
  return {
    rows,
    unread,
    latestUnread: rows.find((n) => !n.read),
    markAllRead: doMarkAllRead,
    markRead: doMarkRead,
  };
}
