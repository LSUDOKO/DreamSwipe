/**
 * Reading duel events out of transaction receipts.
 *
 * The duel id is assigned ON CHAIN (`keccak256(chainid, contract, seq,
 * sender)`) and published in `DuelCreated`, so the client must read it back
 * rather than predicting it. Predicting would mean duplicating the contract's
 * sequence counter in the browser, which drifts the moment two duels are
 * created concurrently.
 */
import type { Config } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import { decodeEventLog, type Hex } from "viem"
import { duelAbi } from "./duel-abi"
import { DUEL_ADDRESS } from "./chain"

/**
 * Extract the duel id from a `createDuel` transaction.
 *
 * Returns null when the receipt carries no `DuelCreated` — the caller must
 * treat that as a failure rather than inventing an id.
 */
export async function duelIdFromReceipt(
  config: Config,
  hash: Hex
): Promise<Hex | null> {
  const receipt = await waitForTransactionReceipt(config, { hash })
  if (receipt.status !== "success") return null

  for (const log of receipt.logs) {
    // Other contracts can emit into the same transaction; only ours counts.
    if (log.address.toLowerCase() !== DUEL_ADDRESS.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: duelAbi,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName === "DuelCreated") {
        return (decoded.args as unknown as { duelId: Hex }).duelId
      }
    } catch {
      // A log from our address that is not a DuelCreated — skip it.
    }
  }
  return null
}
