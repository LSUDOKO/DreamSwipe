/**
 * Matchmaking balance gate.
 *
 * Refuses to queue a player who cannot actually settle the duel they are
 * joining, so the failure surfaces in the lobby rather than as a reverted
 * transaction after a match is made and an opponent is already waiting.
 *
 * ── Simpler than the Sui version ────────────────────────────────────────────
 *
 * The old gate checked a DeepBook `AccountWrapper` balance and had a distinct
 * "no funding account yet" failure mode, because a player had to create and
 * fund a second account before they could play. On Somnia the wallet holds the
 * ERC-20 directly, so there is no account to be missing — only a balance that
 * is or is not enough.
 *
 * ── Free duels are never gated ──────────────────────────────────────────────
 *
 * A zero-stake duel moves no collateral, so requiring a balance for one would
 * lock new players out of the mode that exists to onboard them.
 */
import { createPublicClient, erc20Abi, http, type Hex } from "viem"
import { somniaTestnet } from "viem/chains"
import { makeLogger } from "./log"

const log = makeLogger("balance-gate")

/** Shannon testnet collateral (tUSDC, 6 decimals). */
const DEFAULT_COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E"

export type GateReason = "ok" | "insufficient_balance" | "read_failed"

export interface GateResult {
  ok: boolean
  reason: GateReason
  /** Collateral held, base units. `0n` when the read failed. */
  balance: bigint
  /** What was required, base units. */
  required: bigint
}

let client: ReturnType<typeof createPublicClient> | null = null
function getClient() {
  client ??= createPublicClient({
    chain: somniaTestnet,
    transport: http(
      process.env.SOMNIA_RPC_URL || "https://dream-rpc.somnia.network"
    ),
  })
  return client
}

function collateralAddress(): Hex {
  const addr = process.env.COLLATERAL_TOKEN || DEFAULT_COLLATERAL
  return addr as Hex
}

/**
 * Can this address afford to enter at `stake`?
 *
 * Requires only the stake itself. The old gate also reserved a per-swipe
 * premium budget because each DeepBook swipe minted a position paid from the
 * player's account; DreamSwipe's swipes are relayed and the premium is
 * recorded rather than charged to the player's wallet, so there is nothing
 * extra to reserve.
 *
 * A failed read is reported as `read_failed`, NOT as an insufficient balance:
 * telling a funded player they are broke because an RPC hiccuped is worse than
 * letting them through and failing loudly later.
 */
export async function checkQueueBalanceGate(
  address: string,
  stake: bigint
): Promise<GateResult> {
  if (stake <= 0n) {
    return { ok: true, reason: "ok", balance: 0n, required: 0n }
  }

  try {
    const balance = (await getClient().readContract({
      address: collateralAddress(),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as Hex],
    })) as bigint

    return balance >= stake
      ? { ok: true, reason: "ok", balance, required: stake }
      : {
          ok: false,
          reason: "insufficient_balance",
          balance,
          required: stake,
        }
  } catch (e) {
    log.warn(
      `balance read failed for ${address.slice(0, 10)}: ${(e as Error).message}`
    )
    // Fail open — see the docstring.
    return { ok: true, reason: "read_failed", balance: 0n, required: stake }
  }
}
