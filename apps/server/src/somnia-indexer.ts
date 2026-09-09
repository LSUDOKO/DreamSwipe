/**
 * Somnia duel indexer.
 *
 * Mirrors on-chain duel state into the `duel` table and broadcasts `room_state`
 * to subscribed sockets.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * The Sui build had an event indexer that wrote every duel into Postgres. It
 * was deleted with the chain layer, and nothing replaced it — which broke more
 * than it looked like:
 *
 *   - `sendRoomSnapshot` reads the duel row, finds nothing, and returns early,
 *     so `room_state` is NEVER sent. A client sits on AWAIT_REVEAL forever
 *     after `createDuel` lands, and the duel looks unrejoinable.
 *   - `/duels/:id` and `/game/history` 404 with "duel not indexed yet".
 *   - The keeper discovers work through an in-memory `trackDuel()` set that
 *     nothing ever called, so cards never settled and `finalize` never paid.
 *
 * Every one of those failures is silent: no error, no log, just a screen that
 * never advances. That is the failure mode this module removes.
 *
 * ── Chain is authoritative ──────────────────────────────────────────────────
 *
 * The table is a CACHE for reads, never a source of truth. Every field is read
 * back from the contract, and a duel is only ever advanced by what the chain
 * says — matching the master spec's rule that canonical chain evidence
 * outranks server cache.
 */
import { createPublicClient, http, parseAbi, type Hex } from "viem"
import { somniaTestnet } from "viem/chains"
import { upsertDuel } from "./db"
import { makeLogger } from "./log"
import { trackDuel } from "./somnia-keeper"
import { refreshRoom } from "./ws/matchmaking"

const log = makeLogger("somnia-indexer")

/** How often to refresh tracked duels from chain. */
const POLL_INTERVAL_MS = 5_000

/**
 * How far back to scan for `DuelCreated` on boot.
 *
 * Somnia caps `getLogs` at 1000 blocks per call, and blocks are fast, so this
 * is a recovery window rather than full history: a restart picks up duels
 * created in the last few minutes. Anything older is still reachable by id
 * through `indexDuel`, which reads state directly.
 */
const BACKFILL_WINDOWS = 20
const WINDOW_BLOCKS = 1000n

const DUEL_ABI = parseAbi([
  "event DuelCreated(bytes32 indexed duelId, address indexed creator, uint8 tier, address stakeToken, uint128 stake, uint8 deckSize, bytes32 deckCommit)",
  "function getDuel(bytes32) view returns ((uint8,uint8,address,address,address,uint128,uint8,uint8,bool,bytes32,uint64,uint64,int256,int256))",
  "function getDeck(bytes32) view returns ((bytes32,uint256)[])",
])

const STATUS = ["NONE", "PENDING", "ACTIVE", "COMPLETE"] as const

export class SomniaIndexer {
  private readonly pub
  private readonly address: Hex
  private timer: ReturnType<typeof setInterval> | null = null
  /** Duels this process mirrors. Repopulated from chain on boot. */
  private readonly tracked = new Set<string>()

  constructor(address: Hex, rpcUrl?: string) {
    this.address = address
    this.pub = createPublicClient({
      chain: somniaTestnet,
      transport: http(
        rpcUrl ||
          process.env.SOMNIA_RPC_URL ||
          "https://dream-rpc.somnia.network"
      ),
    })
  }

  /** Register a duel for mirroring, and hand it to the settlement keeper. */
  track(duelId: string): void {
    this.tracked.add(duelId)
    // Without this the keeper never learns the duel exists, so its cards never
    // settle and nobody is ever paid.
    trackDuel(duelId)
  }

  async start(): Promise<void> {
    if (this.timer) return
    log.info(`indexing duels at ${this.address}`)
    await this.backfill().catch((e) =>
      log.warn(`backfill failed: ${(e as Error).message}`)
    )
    this.timer = setInterval(() => {
      void this.refreshAll().catch((e) =>
        log.warn(`refresh failed: ${(e as Error).message}`)
      )
    }, POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Recover recent duels after a restart. */
  private async backfill(): Promise<void> {
    const head = await this.pub.getBlockNumber()
    let found = 0
    for (let i = 0; i < BACKFILL_WINDOWS; i++) {
      const toBlock = head - BigInt(i) * WINDOW_BLOCKS
      const fromBlock = toBlock - (WINDOW_BLOCKS - 1n)
      if (fromBlock < 0n) break
      try {
        const logs = await this.pub.getLogs({
          address: this.address,
          event: DUEL_ABI[0],
          fromBlock,
          toBlock,
        })
        for (const l of logs) {
          const id = (l as { args?: { duelId?: Hex } }).args?.duelId
          if (id) {
            this.track(id)
            found++
          }
        }
      } catch {
        // A window can fail on a public RPC; backfill is best-effort.
      }
    }
    if (found > 0) log.info(`backfilled ${found} duel(s)`)
  }

  private async refreshAll(): Promise<void> {
    for (const id of [...this.tracked]) {
      try {
        await this.indexDuel(id as Hex)
      } catch (e) {
        log.warn(`index ${id.slice(0, 10)} failed: ${(e as Error).message}`)
      }
    }
  }

  /**
   * Read one duel from chain, mirror it, and broadcast to its room.
   *
   * Safe to call for an unknown id: an uncreated duel reads status 0 and is
   * skipped rather than written as a phantom row.
   */
  async indexDuel(duelId: Hex): Promise<void> {
    const [raw, deck] = await Promise.all([
      this.pub.readContract({
        address: this.address,
        abi: DUEL_ABI,
        functionName: "getDuel",
        args: [duelId],
      }),
      this.pub.readContract({
        address: this.address,
        abi: DUEL_ABI,
        functionName: "getDeck",
        args: [duelId],
      }),
    ])

    const d = raw as readonly [
      number,
      number,
      string,
      string,
      string,
      bigint,
      number,
      number,
      boolean,
      string,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    const status = STATUS[d[0]] ?? "NONE"
    if (status === "NONE") return // never created — do not write a phantom row

    // viem decodes the tuple[] positionally: [marketId, strike].
    const cards = (deck as readonly (readonly [Hex, bigint])[]).map((c) => ({
      expiry_market_id: c[0],
      strike: c[1].toString(),
    }))

    // The contract keeps ONE signed score per player. The mirror's schema
    // predates that and stores payout/premium separately, so a positive score
    // maps to payout and a negative one to premium — identical wherever the
    // UI computes `payout - premium`, and no number is invented.
    const p0 = d[12] >= 0n ? [d[12], 0n] : [0n, -d[12]]
    const p1 = d[13] >= 0n ? [d[13], 0n] : [0n, -d[13]]

    await upsertDuel({
      id: duelId,
      status: status as "PENDING" | "ACTIVE" | "COMPLETE",
      stakeCoinType: d[4],
      creator: d[2],
      challenger: d[3],
      cardsRevealed: d[8],
      cardCount: d[6],
      settledCount: d[7],
      p0Payout: p0[0]!.toString(),
      p0Premium: p0[1]!.toString(),
      p1Payout: p1[0]!.toString(),
      p1Premium: p1[1]!.toString(),
      startedAtMs: Number(d[11]) * 1000,
      cardOutcomes: [],
      swipes: [],
      cards,
    })

    // Push the fresh state to anyone watching this duel, so a client that
    // subscribed mid-duel advances instead of waiting on an event that is
    // never coming.
    await refreshRoom(duelId)

    // A finished duel needs no further polling.
    if (status === "COMPLETE") this.tracked.delete(duelId)
  }

  get trackedCount(): number {
    return this.tracked.size
  }
}

/** Build an indexer from env, or null when no duel contract is configured. */
export function createSomniaIndexer(): SomniaIndexer | null {
  const addr = process.env.DREAMSWIPE_DUEL_ADDRESS
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null
  return new SomniaIndexer(addr as Hex)
}
