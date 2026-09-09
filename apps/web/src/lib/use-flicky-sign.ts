/**
 * Single transaction entrypoint for the app — the EVM replacement for the
 * Sui sponsored-gas signing hook.
 *
 * ── What changed ────────────────────────────────────────────────────────────
 *
 * The Sui build routed every transaction through a sponsor service so a
 * zkLogin wallet holding only dUSDC could still transact. On Somnia the player
 * holds STT and pays their own gas for the few transactions that need one
 * (create, join, finalize, refund).
 *
 * The gas-free path that actually matters — the per-swipe one — is handled
 * differently and better: swipes are EIP-712 signatures relayed by the server,
 * so a player never sees a wallet popup mid-duel. See `signSwipe` in
 * `lib/duel.ts`.
 *
 * The hook keeps its `{ mutateAsync, isPending }` shape so existing call sites
 * migrate without restructuring their async flow.
 */
import { useCallback, useState } from "react"
import { useConfig } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import type { Config } from "wagmi"
import type { Hex } from "viem"

export interface SendResult {
  /** The real transaction hash. Never synthesized. */
  hash: Hex
  /** Kept as `digest` so Sui-era call sites reading `res.digest` still work. */
  digest: Hex
  blockNumber: bigint
}

/**
 * Run a contract write and wait for it to actually land.
 *
 * Waiting for the receipt (rather than returning on submission) is deliberate:
 * on Somnia a transaction can mine with `status: 0` while consuming its whole
 * gas limit, so "submitted" is not "succeeded". A reverted transaction throws
 * here instead of letting the UI show a success it did not earn.
 */
export function useFlickySign() {
  const config = useConfig()
  const [isPending, setIsPending] = useState(false)

  const mutateAsync = useCallback(
    async ({
      send,
    }: {
      /** Performs the write and resolves to its hash. */
      send: (config: Config) => Promise<Hex>
    }): Promise<SendResult> => {
      setIsPending(true)
      try {
        const hash = await send(config)
        const receipt = await waitForTransactionReceipt(config, { hash })
        if (receipt.status !== "success") {
          throw new Error(
            `Transaction reverted (${hash.slice(0, 10)}…). On Somnia this can ` +
              `also mean the gas limit was too low — state creation is priced ` +
              `far above Ethereum.`
          )
        }
        return { hash, digest: hash, blockNumber: receipt.blockNumber }
      } finally {
        setIsPending(false)
      }
    },
    [config]
  )

  return { mutateAsync, isPending }
}
