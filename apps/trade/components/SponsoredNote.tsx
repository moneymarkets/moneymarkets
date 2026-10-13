/**
 * Why the network fee says "Paid for you" (ITEM 8).
 *
 * "Paid for you" is design §6's required wording and it is accurate, but on its own it
 * reads like a promotion — and the obvious next question, *paid by whom, and what
 * happens when they stop*, had no answer anywhere in the app. One sentence, at each
 * place the phrase appears, rather than a page nobody opens.
 *
 * It states the mechanism rather than a promise: this account is sponsored, so the
 * user never has to hold MON. It does not claim the sponsorship is unlimited, because
 * it is not — the relayer has a float and a per-order cap, and both refuse in their own
 * words when they bind.
 */
export function SponsoredNote({ style }: { style?: React.CSSProperties }) {
  return (
    <p className="tiny muted" style={{ marginTop: 6, ...style }}>
      Monad charges a fee for every transaction. This account is sponsored, so that fee is paid on
      your behalf and you never need to hold MON to use the app.
    </p>
  );
}
