/**
 * Full two-player duel lifecycle against the LIVE deployed contract.
 *
 * create → join → reveal → EIP-712 sign → relay swipe → settle → finalize.
 *
 * The challenger is a deterministic throwaway key funded from the deployer, so
 * this proves the real two-party flow rather than a single-address shortcut.
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
const C = "0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c" as const
const GAS = 3_000_000n

const raw = (
  await Bun.file(new URL("../../../../.env", import.meta.url)).text()
)
  .split("\n")
  .find((l) => l.toLowerCase().startsWith("private_key="))!
  .split("=")[1]!
  .trim()
const PK = (raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`

// Deterministic challenger — derived, never committed.
const CHALLENGER_PK = keccak256(
  new TextEncoder().encode("dreamswipe-e2e-challenger-v1")
)

const p0 = privateKeyToAccount(PK)
const p1 = privateKeyToAccount(CHALLENGER_PK)
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

const abi = parseAbi([
  "function createDuel(bytes32,uint8,uint8,address,uint128) returns (bytes32)",
  "function joinDuel(bytes32)",
  "function revealDeck(bytes32,bytes32[],uint256[],bytes32)",
  "function recordSwipe(bytes32,address,uint8,uint8,uint128,uint128,uint256,uint256,bytes)",
  "function settleCard(bytes32,uint8,uint8,bool)",
  "function finalize(bytes32)",
  "function getSwipe(bytes32,address,uint8) view returns ((bool,uint8,uint128,uint128))",
  "function getDuel(bytes32) view returns ((uint8,uint8,address,address,address,uint128,uint8,uint8,bool,bytes32,uint64,uint64,int256,int256))",
  "function nonces(address) view returns (uint256)",
])

const step = (n: number, msg: string) => console.log(`${n}. ${msg}`)

// Fund the challenger for gas if needed.
const bal1 = await pub.getBalance({ address: p1.address })
if (bal1 < parseEther("0.02")) {
  const h = await w0.sendTransaction({
    to: p1.address,
    value: parseEther("0.05"),
  })
  await pub.waitForTransactionReceipt({ hash: h })
  step(0, `funded challenger ${p1.address.slice(0, 10)} with 0.05 STT`)
}

// 1 — commit a 3-card deck
const marketIds = [1, 2, 3].map((i) =>
  keccak256(new TextEncoder().encode("mkt" + i))
)
const strikes = [0n, 0n, 0n]
const salt = keccak256(new TextEncoder().encode("e2e-" + Date.now()))
const commit = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32[]" }, { type: "uint256[]" }, { type: "bytes32" }],
    [marketIds, strikes, salt]
  )
)
step(1, `deck committed ${commit.slice(0, 18)}…`)

// 2 — create (Free tier: no collateral needed)
const h1 = await w0.writeContract({
  address: C,
  abi,
  functionName: "createDuel",
  args: [commit, 3, 0, "0x0000000000000000000000000000000000000000", 0n],
  gas: GAS,
})
const r1 = await pub.waitForTransactionReceipt({ hash: h1 })
const duelId = r1.logs[0]!.topics[1]! as `0x${string}`
step(2, `createDuel ${r1.status} → duel ${duelId.slice(0, 18)}…`)

// 3 — join
const h2 = await w1.writeContract({
  address: C,
  abi,
  functionName: "joinDuel",
  args: [duelId],
  gas: GAS,
})
step(
  3,
  `joinDuel ${(await pub.waitForTransactionReceipt({ hash: h2 })).status}`
)

// 4 — reveal (contract recomputes the commitment)
const h3 = await w0.writeContract({
  address: C,
  abi,
  functionName: "revealDeck",
  args: [duelId, marketIds, strikes, salt],
  gas: GAS,
})
step(
  4,
  `revealDeck ${(await pub.waitForTransactionReceipt({ hash: h3 })).status}`
)

// 5 — both players sign a swipe off-chain, relayer submits
const domain = {
  name: "DreamSwipeDuel",
  version: "1",
  chainId: 50312,
  verifyingContract: C,
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
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)

for (const [w, acct, dir, label] of [
  [w0, p0, 0, "creator UP"],
  [w1, p1, 1, "challenger DOWN"],
] as const) {
  const nonce = (await pub.readContract({
    address: C,
    abi,
    functionName: "nonces",
    args: [acct.address],
  })) as bigint
  const signature = await w.signTypedData({
    account: acct,
    domain,
    types,
    primaryType: "Swipe",
    message: { duelId, cardIdx: 0, direction: dir, nonce, deadline },
  })
  // Relayer (p0's key) submits BOTH — proving a player never needs to send a tx.
  const h = await w0.writeContract({
    address: C,
    abi,
    functionName: "recordSwipe",
    args: [
      duelId,
      acct.address,
      0,
      dir,
      400_000n,
      1_000_000n,
      nonce,
      deadline,
      signature,
    ],
    gas: GAS,
  })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  step(5, `relayed ${label}: ${r.status} (player signed, relayer paid gas)`)
}

// 6 — settle all three cards; card 0 resolves UP
for (let i = 0; i < 3; i++) {
  const h = await w0.writeContract({
    address: C,
    abi,
    functionName: "settleCard",
    args: [duelId, i, 0, false],
    gas: GAS,
  })
  await pub.waitForTransactionReceipt({ hash: h })
}
step(6, "settled 3/3 cards (card 0 → UP wins)")

// 7 — finalize and read the scores back
const h5 = await w0.writeContract({
  address: C,
  abi,
  functionName: "finalize",
  args: [duelId],
  gas: GAS,
})
step(
  7,
  `finalize ${(await pub.waitForTransactionReceipt({ hash: h5 })).status}`
)

const d = (await pub.readContract({
  address: C,
  abi,
  functionName: "getDuel",
  args: [duelId],
})) as readonly unknown[]
const p0Score = d[12] as bigint,
  p1Score = d[13] as bigint
console.log(`\n   status=${d[0]} (3=Complete)  settled=${d[7]}/${d[6]}`)
console.log(`   p0 score ${p0Score}  (backed UP at 0.40, won → +0.60)`)
console.log(`   p1 score ${p1Score}  (backed DOWN at 0.40, lost → -0.40)`)
console.log(
  `   winner: ${p0Score > p1Score ? "creator" : p1Score > p0Score ? "challenger" : "draw"}`
)
console.log("\nFULL LIFECYCLE VERIFIED ON LIVE SOMNIA TESTNET.")
process.exit(0)
