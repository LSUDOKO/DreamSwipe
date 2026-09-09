/**
 * Somnia settlement keeper.
 *
 * Watches active duels and, as each card's market resolves on DreamDEX, writes
 * the outcome to `DreamSwipeDuel.settleCard`. Once every card is settled it
 * calls `finalize`, which pays the winner.
 *
 * ── Why the keeper reads the venue rather than being told ───────────────────
 *
 * Settlement is the one place a lie would directly move money, so the outcome
 * comes from `getSettlement` against the venue's own on-chain state — never
 * from a client, never from a cached list. `specs/05_BACKEND.md` puts it as
 * "verify venue evidence before writing settlement".
 *
 * ── Idempotency is the contract's job, not ours ─────────────────────────────
 *
 * `settleCard` reverts on an already-settled card and `finalize` reverts
 * unless every card is accounted for. So a keeper restart mid-duel is safe: it
 * re-attempts, the chain rejects the duplicates, and nothing is double-counted.
 * That is deliberate — a keeper that had to remember what it had done would
 * lose that memory on exactly the restart it needed it.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { somniaTestnet } from "viem/chains"
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"
import { makeLogger } from "./log"

const log = makeLogger("somnia-keeper")

/** How often to sweep active duels for newly-settled cards. */
const SWEEP_INTERVAL_MS = 30_000

const KEEPER_ABI = [
  {
    type: "function",
    name: "settleCard",
    stateMutability: "nonpayable",
    inputs: [
      { name: "duelId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
      { name: "winner", type: "uint8" },
      { name: "voided", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealDeck",
    stateMutability: "nonpayable",
    inputs: [
      { name: "duelId", type: "bytes32" },
      { name: "marketIds", type: "bytes32[]" },
      { name: "strikes", type: "uint256[]" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isCardSettled",
    stateMutability: "view",
    inputs: [
      { name: "duelId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getDeck",
    stateMutability: "view",
    inputs: [{ name: "duelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "marketId", type: "bytes32" },
          { name: "strike", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDuel",
    stateMutability: "view",
    inputs: [{ name: "duelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "tier", type: "uint8" },
          { name: "creator", type: "address" },
          { name: "challenger", type: "address" },
          { name: "stakeToken", type: "address" },
          { name: "stake", type: "uint128" },
          { name: "deckSize", type: "uint8" },
          { name: "settledCount", type: "uint8" },
          { name: "deckRevealed", type: "bool" },
          { name: "deckCommit", type: "bytes32" },
          { name: "createdAtSec", type: "uint64" },
          { name: "startedAtSec", type: "uint64" },
          { name: "p0Score", type: "int256" },
          { name: "p1Score", type: "int256" },
        ],
      },
    ],
  },
] as const

const DIRECTION_UP = 0
const DIRECTION_DOWN = 1
const STATUS_ACTIVE = 2

export interface KeeperConfig {
  duelAddress: Hex
  privateKey: Hex
  rpcUrl?: string
}

/** Duels this process is tracking. Restart-safe: the chain is the source. */
const tracked = new Set<string>()

/** Register a duel for settlement sweeps. */
export function trackDuel(duelId: string): void {
  tracked.add(duelId)
}

export function untrackDuel(duelId: string): void {
  tracked.delete(duelId)
}

export function trackedDuels(): string[] {
  return [...tracked]
}

export class SomniaKeeper {
  private readonly pub
  private readonly wallet
  private readonly account
  private readonly duelAddress: Hex
  private readonly venue: SomniaDreamDexAdapter
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(config: KeeperConfig) {
    const rpcUrl =
      config.rpcUrl ||
      process.env.SOMNIA_RPC_URL ||
      "https://dream-rpc.somnia.network"
    this.duelAddress = config.duelAddress
    this.account = privateKeyToAccount(config.privateKey)
    this.pub = createPublicClient({
      chain: somniaTestnet,
      transport: http(rpcUrl),
    })
    this.wallet = createWalletClient({
      account: this.account,
      chain: somniaTestnet,
      transport: http(rpcUrl),
    })
    this.venue = new SomniaDreamDexAdapter({ rpcUrl })
  }

  get address(): string {
    return this.account.address
  }

  start(): void {
    if (this.timer) return
    log.info(`keeper started as ${this.account.address}`)
    this.timer = setInterval(() => {
      void this.sweep().catch((e) =>
        log.error(`sweep failed: ${(e as Error).message}`)
      )
    }, SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass over every tracked duel. */
  async sweep(): Promise<void> {
    for (const duelId of [...tracked]) {
      try {
        await this.settleDuel(duelId as Hex)
      } catch (e) {
        log.error(
          `duel ${duelId.slice(0, 10)} sweep failed: ${(e as Error).message}`
        )
      }
    }
  }

  /**
   * Settle whatever is ready on one duel, and finalize when complete.
   */
  async settleDuel(duelId: Hex): Promise<void> {
    const duel = (await this.pub.readContract({
      address: this.duelAddress,
      abi: KEEPER_ABI,
      functionName: "getDuel",
      args: [duelId],
    })) as {
      status: number
      deckSize: number
      settledCount: number
      deckRevealed: boolean
    }

    if (duel.status !== STATUS_ACTIVE) {
      // Finalized, refunded, or never existed — stop spending reads on it.
      tracked.delete(duelId)
      return
    }
    if (!duel.deckRevealed) return

    const deck = (await this.pub.readContract({
      address: this.duelAddress,
      abi: KEEPER_ABI,
      functionName: "getDeck",
      args: [duelId],
    })) as readonly { marketId: Hex; strike: bigint }[]

    for (let cardIdx = 0; cardIdx < deck.length; cardIdx++) {
      const already = (await this.pub.readContract({
        address: this.duelAddress,
        abi: KEEPER_ABI,
        functionName: "isCardSettled",
        args: [duelId, cardIdx],
      })) as boolean
      if (already) continue

      // The authoritative read: has the VENUE resolved this market?
      const settlement = await this.venue
        .getSettlement(deck[cardIdx]!.marketId)
        .catch(() => null)
      if (!settlement) continue // still open — nothing to write yet

      const winner =
        settlement.winner === "DOWN" ? DIRECTION_DOWN : DIRECTION_UP

      try {
        const { request } = await this.pub.simulateContract({
          address: this.duelAddress,
          abi: KEEPER_ABI,
          functionName: "settleCard",
          account: this.account,
          args: [duelId, cardIdx, winner, settlement.voided],
        })
        const hash = await this.wallet.writeContract(request)
        await this.pub.waitForTransactionReceipt({ hash })
        log.info(
          `settled duel=${duelId.slice(0, 10)} card=${cardIdx} ` +
            `winner=${settlement.voided ? "VOID" : settlement.winner} tx=${hash.slice(0, 10)}`
        )
      } catch (e) {
        // An already-settled card reverts — that is the contract enforcing
        // idempotency, not an error worth escalating.
        const msg = (e as Error).message
        if (/CardAlreadySettled/.test(msg)) continue
        log.error(`settleCard(${cardIdx}) failed: ${msg.slice(0, 200)}`)
      }
    }

    // Finalize once every card is accounted for.
    const after = (await this.pub.readContract({
      address: this.duelAddress,
      abi: KEEPER_ABI,
      functionName: "getDuel",
      args: [duelId],
    })) as { deckSize: number; settledCount: number; status: number }

    if (
      after.status === STATUS_ACTIVE &&
      after.settledCount >= after.deckSize
    ) {
      try {
        const { request } = await this.pub.simulateContract({
          address: this.duelAddress,
          abi: KEEPER_ABI,
          functionName: "finalize",
          account: this.account,
          args: [duelId],
        })
        const hash = await this.wallet.writeContract(request)
        await this.pub.waitForTransactionReceipt({ hash })
        log.info(
          `finalized duel=${duelId.slice(0, 10)} tx=${hash.slice(0, 10)}`
        )
        tracked.delete(duelId)
      } catch (e) {
        log.error(`finalize failed: ${(e as Error).message.slice(0, 200)}`)
      }
    }
  }

  /**
   * Reveal a committed deck.
   *
   * Called once both players have staked. The contract recomputes the
   * commitment and rejects a substituted deck, which is what makes the
   * commit-reveal actually binding rather than a promise.
   */
  async revealDeck(
    duelId: Hex,
    marketIds: Hex[],
    strikes: bigint[],
    salt: Hex
  ): Promise<string> {
    const { request } = await this.pub.simulateContract({
      address: this.duelAddress,
      abi: KEEPER_ABI,
      functionName: "revealDeck",
      account: this.account,
      args: [duelId, marketIds, strikes, salt],
    })
    const hash = await this.wallet.writeContract(request)
    await this.pub.waitForTransactionReceipt({ hash })
    trackDuel(duelId)
    log.info(
      `revealed deck for duel=${duelId.slice(0, 10)} tx=${hash.slice(0, 10)}`
    )
    return hash
  }
}

/** Build a keeper from env, or null when it is not configured. */
export function createSomniaKeeper(): SomniaKeeper | null {
  const addr = process.env.DREAMSWIPE_DUEL_ADDRESS
  const rawKey =
    process.env.KEEPER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || ""
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null
  return new SomniaKeeper({
    duelAddress: addr as Hex,
    privateKey: key as Hex,
  })
}
