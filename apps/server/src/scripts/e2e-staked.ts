/**
 * Full STAKED duel lifecycle against the live contract.
 *
 * The free-tier run (`e2e-somnia.ts`) proved the engine; this proves the money:
 * both players escrow real tUSDC, and the winner is paid the whole pot.
 *
 * Collateral comes from the token's own on-chain `faucet(uint256)` — no
 * external faucet step is needed.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  parseEther,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { somniaTestnet } from "viem/chains"

const RPC = "https://dream-rpc.somnia.network"
const DUEL = "0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c" as const
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const
const ONE = 1_000_000n
const STAKE = 5n * ONE // 5 tUSDC per side
const GAS = 4_000_000n

const raw = (
  await Bun.file(new URL("../../../../.env", import.meta.url)).text()
)
  .split("\n")
  .find((l) => l.toLowerCase().startsWith("private_key="))!
  .split("=")[1]!
  .trim()
const PK = (raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`

const p0 = privateKeyToAccount(PK)
const p1 = privateKeyToAccount(
  keccak256(new TextEncoder().encode("dreamswipe-staked-challenger-v1"))
)
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) })
const w0 = createWalletClient({
  account: p0,
  chain: somniaTestnet,
  transport: http(RPC),
})
const w1 = createWalletClient({
  account: p1,
  chain: somniaTestnet,
  transport: http(RPC),
})

const erc20 = parseAbi([
  "function faucet(uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
])
const duel = parseAbi([
  "function createDuel(bytes32,uint8,uint8,address,uint128) returns (bytes32)",
  "function joinDuel(bytes32)",
  "function revealDeck(bytes32,bytes32[],uint256[],bytes32)",
  "function recordSwipe(bytes32,address,uint8,uint8,uint128,uint128,uint256,uint256,bytes)",
  "function settleCard(bytes32,uint8,uint8,bool)",
  "function finalize(bytes32)",
  "function getDuel(bytes32) view returns ((uint8,uint8,address,address,address,uint128,uint8,uint8,bool,bytes32,uint64,uint64,int256,int256))",
  "function nonces(address) view returns (uint256)",
])

const step = (n: number, m: string) => console.log(`${n}. ${m}`)
const send = async (c: typeof w0, p: Parameters<typeof w0.writeContract>[0]) =>
  (await pub.waitForTransactionReceipt({ hash: await c.writeContract(p) }))
    .status
const bal = (a: `0x${string}`) =>
  pub.readContract({
    address: TUSDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [a],
  })

// ── Fund both sides ────────────────────────────────────────────────────────
if ((await pub.getBalance({ address: p1.address })) < parseEther("0.02")) {
  await pub.waitForTransactionReceipt({
    hash: await w0.sendTransaction({
      to: p1.address,
      value: parseEther("0.05"),
    }),
  })
  step(0, `funded challenger gas`)
}
if ((await bal(p0.address)) < STAKE) {
  // Somnia's estimate is unreliable both ways here, so the limit is explicit.
  await send(w0, {
    address: TUSDC,
    abi: erc20,
    functionName: "faucet",
    args: [5000n * ONE],
    gas: GAS,
  })
  step(0, "creator drew tUSDC from the on-chain faucet")
}
if ((await bal(p1.address)) < STAKE) {
  await send(w0, {
    address: TUSDC,
    abi: erc20,
    functionName: "transfer",
    args: [p1.address, 50n * ONE],
    gas: GAS,
  })
  step(0, "sent challenger 50 tUSDC")
}

const p0Start = await bal(p0.address)
const p1Start = await bal(p1.address)
step(1, `stakes: ${STAKE} each · p0 holds ${p0Start} · p1 holds ${p1Start}`)

// ── Approve escrow ─────────────────────────────────────────────────────────
step(
  2,
  `approve p0 ${await send(w0, { address: TUSDC, abi: erc20, functionName: "approve", args: [DUEL, STAKE], gas: GAS })}`
)
step(
  2,
  `approve p1 ${await send(w1, { address: TUSDC, abi: erc20, functionName: "approve", args: [DUEL, STAKE], gas: GAS })}`
)

// ── Duel ───────────────────────────────────────────────────────────────────
const marketIds = [1, 2, 3].map((i) =>
  keccak256(new TextEncoder().encode("staked-mkt" + i))
)
const strikes = [0n, 0n, 0n]
const salt = keccak256(new TextEncoder().encode("staked-" + Date.now()))
const commit = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32[]" }, { type: "uint256[]" }, { type: "bytes32" }],
    [marketIds, strikes, salt]
  )
)

const h = await w0.writeContract({
  address: DUEL,
  abi: duel,
  functionName: "createDuel",
  args: [commit, 3, 1 /* Staked */, TUSDC, STAKE],
  gas: GAS,
})
const r = await pub.waitForTransactionReceipt({ hash: h })
const duelId = r.logs.find(
  (l) => l.address.toLowerCase() === DUEL.toLowerCase()
)!.topics[1]! as `0x${string}`
step(3, `createDuel(STAKED) ${r.status} → ${duelId.slice(0, 18)}…`)
step(4, `escrow now holds ${await bal(DUEL)} (one stake)`)

step(
  5,
  `joinDuel ${await send(w1, { address: DUEL, abi: duel, functionName: "joinDuel", args: [duelId], gas: GAS })}`
)
step(6, `escrow now holds ${await bal(DUEL)} (both stakes)`)
step(
  7,
  `revealDeck ${await send(w0, { address: DUEL, abi: duel, functionName: "revealDeck", args: [duelId, marketIds, strikes, salt], gas: GAS })}`
)

const domain = {
  name: "DreamSwipeDuel",
  version: "1",
  chainId: 50312,
  verifyingContract: DUEL,
} as const
const types = {
  Swipe: [
    { name: "duelId", type: "bytes32" },
    { name: "cardIdx", type: "uint8" },
    { name: "direction", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const
const deadline = BigInt(Math.floor(Date.now() / 1000) + 900)

for (const [w, a, dir, label] of [
  [w0, p0, 0, "creator UP"],
  [w1, p1, 1, "challenger DOWN"],
] as const) {
  const nonce = (await pub.readContract({
    address: DUEL,
    abi: duel,
    functionName: "nonces",
    args: [a.address],
  })) as bigint
  const signature = await w.signTypedData({
    account: a,
    domain,
    types,
    primaryType: "Swipe",
    message: { duelId, cardIdx: 0, direction: dir, nonce, deadline },
  })
  // The relayer (p0's key) submits BOTH — neither player sends a transaction.
  step(
    8,
    `relayed ${label} ${await send(w0, {
      address: DUEL,
      abi: duel,
      functionName: "recordSwipe",
      args: [
        duelId,
        a.address,
        0,
        dir,
        400_000n,
        ONE,
        nonce,
        deadline,
        signature,
      ],
      gas: GAS,
    })}`
  )
}

for (let i = 0; i < 3; i++) {
  await send(w0, {
    address: DUEL,
    abi: duel,
    functionName: "settleCard",
    args: [duelId, i, 0 /* UP wins */, false],
    gas: GAS,
  })
}
step(9, "settled 3/3 (card 0 → UP)")
step(
  10,
  `finalize ${await send(w0, { address: DUEL, abi: duel, functionName: "finalize", args: [duelId], gas: GAS })}`
)

// ── Verify the money actually moved ────────────────────────────────────────
const d = (await pub.readContract({
  address: DUEL,
  abi: duel,
  functionName: "getDuel",
  args: [duelId],
})) as readonly unknown[]
const p0End = await bal(p0.address),
  p1End = await bal(p1.address),
  escrow = await bal(DUEL)
console.log(`\n   scores      p0 ${d[12]}  p1 ${d[13]}`)
console.log(
  `   p0 net      ${p0End - p0Start} (staked -5, won pot +10 → expect +5000000)`
)
console.log(
  `   p1 net      ${p1End - p1Start} (staked -5, lost → expect -5000000)`
)
console.log(`   escrow left ${escrow} (expect 0 — nothing stranded)`)
const ok =
  p0End - p0Start === STAKE && p1Start - p1End === STAKE && escrow === 0n
console.log(
  `\n${ok ? "STAKED DUEL VERIFIED: real collateral escrowed and paid out." : "UNEXPECTED — see above"}`
)
process.exit(0)
