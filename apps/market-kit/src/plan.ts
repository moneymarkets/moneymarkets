import { decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';

/**
 * A transaction the kit would send, described completely enough that the owner can
 * read it and decide, and never sent from inside this module.
 *
 * Rule A2.4 / the repo's `MODE` gate: in `dryrun` — the default — every command
 * assembles `PlannedCall`s, prints them, and stops. `submit()` lives in one place
 * (`send.ts`) and refuses unless all three switches are thrown.
 */
export interface PlannedCall {
  /** Short human label, e.g. `deposit AUSD into MarginAccount`. */
  readonly label: string;
  readonly to: Address;
  readonly data: Hex;
  /** Native MON attached, in wei. */
  readonly value: bigint;
  /** Kept so the dry run can decode its own calldata back rather than trusting it. */
  readonly abi: Abi;
  readonly functionName: string;
}

export interface PlanCallInput {
  readonly label: string;
  readonly to: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly value?: bigint;
}

/**
 * Encode a call and immediately decode it back.
 *
 * The round-trip is not ceremony: it is the only cheap way to be sure the bytes that
 * would go on chain are the bytes the printed table describes. A mismatch here is a
 * bug in the argument types (a `number` where a `uint96` belongs, say) and it throws
 * before anything is printed, let alone sent.
 */
export function planCall(input: PlanCallInput): PlannedCall {
  const data = encodeFunctionData({
    abi: input.abi,
    functionName: input.functionName,
    args: input.args as never,
  });
  const decoded = decodeFunctionData({ abi: input.abi, data });
  if (decoded.functionName !== input.functionName) {
    throw new Error(
      `calldata round-trip mismatch: encoded ${input.functionName}, decoded ${decoded.functionName}`,
    );
  }
  return {
    label: input.label,
    to: input.to,
    data,
    value: input.value ?? 0n,
    abi: input.abi,
    functionName: input.functionName,
  };
}

export function selectorOfCall(call: PlannedCall): Hex {
  return call.data.slice(0, 10) as Hex;
}

/** Decode a planned call's arguments from its own calldata. */
export function decodedArgsOf(call: PlannedCall): readonly unknown[] {
  const decoded = decodeFunctionData({ abi: call.abi, data: call.data });
  return (decoded.args ?? []) as readonly unknown[];
}

/** Argument names in ABI order, so the dry run can label what it decoded. */
export function argNamesOf(call: PlannedCall): readonly string[] {
  for (const entry of call.abi) {
    if (entry.type === 'function' && entry.name === call.functionName) {
      return entry.inputs.map((input, i) => input.name || `arg${i}`);
    }
  }
  return [];
}
