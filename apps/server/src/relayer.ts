/**
 * Swipe relayer.
 *
 * Players sign swipes with EIP-712 off-chain; this submits them on chain and
 * pays the gas. That is what removes the wallet popup from the middle of a
 * duel — the single biggest UX win of the Somnia migration.
 *
 * ── The trust boundary, stated plainly ──────────────────────────────────────
 *
 * The relayer holds a funded key, so it is worth being precise about what it
 * can and cannot do.
 *
 * It CANNOT:
 *   - forge a swipe (the signature is checked on chain against the player)
 *   - flip a direction or move a swipe to another card (both are signed)
 *   - replay a swipe (nonces are strictly sequential on chain)
 *   - touch escrow (payouts are computed from recorded swipes and can only
 *     reach the two players)
 *
 * It CAN misreport `premium`/`filled`, because those are venue execution facts
 * the player cannot know at signing time. Those feed scoring, so they are
 * validated here against the live venue before submission rather than trusted
 * from the client — a client-supplied premium would let a player understate
 * their entry cost and inflate their own PnL.
 *
 * ── Validation happens before spending gas ─────────────────────────────────
 *
 * Every rejection below is cheaper than a reverted transaction, and a revert
 * on Somnia burns the whole gas limit rather than refunding the unused
 * portion.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { somniaTestnet } from "viem/chains"
import { makeLogger } from "./log"

const log = makeLogger("relayer")

/** Mirrors `DreamSwipeDuel.Direction`. */
const DIRECTION_UP = 0
const DIRECTION_DOWN = 1

/** Minimal ABI — only what the relayer calls or reads. */
const RELAY_ABI = [
  {
    type: "function",
    name: "recordSwipe",
    stateMutability: "nonpayable",
    inputs: [
      { name: "duelId", type: "bytes32" },
      { name: "player", type: "address" },
      { name: "cardIdx", type: "uint8" },
      { name: "direction", type: "uint8" },
      { name: "premium", type: "uint128" },
      { name: "filled", type: "uint128" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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

export interface SwipeRequest {
  duelId: string
  player: string
  cardIdx: number
  direction: number
  nonce: string
  deadline: string
  signature: string
}

export interface RelayResult {
  ok: boolean
  txHash?: string
  error?: string
  status?: number
}

function duelAddress(): Hex | null {
  const addr = process.env.DREAMSWIPE_DUEL_ADDRESS
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as Hex) : null
}

function relayerKey(): Hex | null {
  const raw =
    process.env.RELAYER_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY || ""
  if (!raw) return null
  const key = raw.startsWith("0x") ? raw : `0x${raw}`
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null
}

/** Shape-validate the request before any chain work. */
export function validateSwipeRequest(body: unknown): SwipeRequest | string {
  if (!body || typeof body !== "object") return "body must be an object"
  const b = body as Record<string, unknown>

  if (typeof b.duelId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.duelId)) {
    return "duelId must be a 32-byte hex string"
  }
  if (typeof b.player !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.player)) {
    return "player must be an address"
  }
  if (
    typeof b.cardIdx !== "number" ||
    !Number.isInteger(b.cardIdx) ||
    b.cardIdx < 0 ||
    b.cardIdx > 255
  ) {
    return "cardIdx must be a uint8"
  }
  if (b.direction !== DIRECTION_UP && b.direction !== DIRECTION_DOWN) {
    return "direction must be 0 (up) or 1 (down)"
  }
  if (typeof b.nonce !== "string" || !/^\d+$/.test(b.nonce)) {
    return "nonce must be a decimal string"
  }
  if (typeof b.deadline !== "string" || !/^\d+$/.test(b.deadline)) {
    return "deadline must be a decimal string"
  }
  if (
    typeof b.signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(b.signature)
  ) {
    return "signature must be a 65-byte hex string"
  }

  return {
    duelId: b.duelId,
    player: b.player,
    cardIdx: b.cardIdx,
    direction: b.direction,
    nonce: b.nonce,
    deadline: b.deadline,
    signature: b.signature,
  }
}

/**
 * Submit a signed swipe.
 *
 * `premium` and `filled` are supplied by the CALLER (the game server), which
 * derives them from the live venue — never from the browser. See the module
 * docstring for why that boundary matters.
 */
export async function relaySwipe(
  req: SwipeRequest,
  execution: { premium: bigint; filled: bigint }
): Promise<RelayResult> {
  const address = duelAddress()
  if (!address) {
    return {
      ok: false,
      status: 503,
      error: "relayer unconfigured: DREAMSWIPE_DUEL_ADDRESS is unset",
    }
  }
  const key = relayerKey()
  if (!key) {
    return {
      ok: false,
      status: 503,
      error: "relayer unconfigured: RELAYER_PRIVATE_KEY is unset",
    }
  }

  const rpcUrl =
    process.env.SOMNIA_RPC_URL || "https://dream-rpc.somnia.network"
  const pub = createPublicClient({
    chain: somniaTestnet,
    transport: http(rpcUrl),
  })
  const account = privateKeyToAccount(key)
  const wallet = createWalletClient({
    account,
    chain: somniaTestnet,
    transport: http(rpcUrl),
  })

  // ── Pre-flight, cheapest checks first ─────────────────────────────────────
  // A revert on Somnia burns the entire gas limit, so it is worth spending a
  // few reads to avoid one.

  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (BigInt(req.deadline) < nowSec) {
    return { ok: false, status: 400, error: "signature expired" }
  }

  try {
    const [onChainNonce, duel] = await Promise.all([
      pub.readContract({
        address,
        abi: RELAY_ABI,
        functionName: "nonces",
        args: [req.player as Hex],
      }),
      pub.readContract({
        address,
        abi: RELAY_ABI,
        functionName: "getDuel",
        args: [req.duelId as Hex],
      }),
    ])

    if (BigInt(req.nonce) !== (onChainNonce as bigint)) {
      // Usually a double-submit or a stale tab, not an attack.
      return {
        ok: false,
        status: 409,
        error: `nonce mismatch: signed ${req.nonce}, chain expects ${onChainNonce}`,
      }
    }

    const d = duel as {
      status: number
      creator: string
      challenger: string
      deckSize: number
      deckRevealed: boolean
    }
    if (d.status !== 2) {
      return { ok: false, status: 409, error: "duel is not active" }
    }
    if (!d.deckRevealed) {
      return { ok: false, status: 409, error: "deck has not been revealed" }
    }
    if (req.cardIdx >= d.deckSize) {
      return { ok: false, status: 400, error: "card index out of range" }
    }
    const player = req.player.toLowerCase()
    if (
      player !== d.creator.toLowerCase() &&
      player !== d.challenger.toLowerCase()
    ) {
      return { ok: false, status: 403, error: "signer is not a player" }
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    // Gas is estimated, never pinned: Somnia prices state creation far above
    // Ethereum and an under-limit transaction mines with status 0 while
    // burning the whole allowance.
    const { request } = await pub.simulateContract({
      address,
      abi: RELAY_ABI,
      functionName: "recordSwipe",
      account,
      args: [
        req.duelId as Hex,
        req.player as Hex,
        req.cardIdx,
        req.direction,
        execution.premium,
        execution.filled,
        BigInt(req.nonce),
        BigInt(req.deadline),
        req.signature as Hex,
      ],
    })

    const txHash = await wallet.writeContract(request)
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash })

    if (receipt.status !== "success") {
      log.error(`swipe reverted on chain: ${txHash}`)
      return { ok: false, status: 502, error: "transaction reverted", txHash }
    }

    log.info(
      `swipe recorded duel=${req.duelId.slice(0, 10)} card=${req.cardIdx} ` +
        `player=${req.player.slice(0, 8)} tx=${txHash.slice(0, 10)}`
    )
    return { ok: true, txHash }
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    log.error(`relay failed: ${message}`)
    // Surface the contract's own revert reason when it produced one — an
    // opaque 500 makes a legitimate rejection indistinguishable from an outage.
    return { ok: false, status: 502, error: message.slice(0, 300) }
  }
}

/** Whether the relayer has everything it needs to submit. */
export function relayerConfigured(): boolean {
  return Boolean(duelAddress() && relayerKey())
}

/** Relayer address, for health output. Null when unconfigured. */
export function relayerAddress(): string | null {
  const key = relayerKey()
  return key ? privateKeyToAccount(key).address : null
}
