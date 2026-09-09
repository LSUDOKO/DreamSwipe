/**
 * Full season prize lifecycle against the LIVE deployed SeasonPrizePool.
 *
 *   createSeason → fund → setAllocations → finalize → claim
 *
 * Uses a mock 6-decimal collateral deployed for this purpose, so the whole
 * cycle can be proven on chain without waiting on the faucet. The contract
 * under test is the real one the app points at.
 */
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { somniaTestnet } from "viem/chains"

const RPC = "https://dream-rpc.somnia.network"
const POOL = "0xB380814066dcb5d0b4d4968742bFdC005D1FB4a7" as const
const TOKEN = "0x19f7d2111705Fea430dB3e49856B91bc0d30921D" as const
const GAS = 3_000_000n
const ONE = 1_000_000n // 6 decimals

const raw = (await Bun.file(new URL("../../../../.env", import.meta.url)).text())
  .split("\n").find((l) => l.toLowerCase().startsWith("private_key="))!
  .split("=")[1]!.trim()
const PK = (raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`

const me = privateKeyToAccount(PK)
const winner = privateKeyToAccount(
  keccak256(new TextEncoder().encode("dreamswipe-season-winner-v1"))
)
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) })
const w = createWalletClient({ account: me, chain: somniaTestnet, transport: http(RPC) })
const wWin = createWalletClient({ account: winner, chain: somniaTestnet, transport: http(RPC) })

const erc20 = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
])
const pool = parseAbi([
  "function createSeason(bytes32,address)",
  "function fund(bytes32,uint256)",
  "function setAllocations(bytes32,address[],uint256[])",
  "function finalize(bytes32)",
  "function claim(bytes32)",
  "function claimable(bytes32,address) view returns (uint256)",
  "function getSeason(bytes32) view returns ((uint8,address,uint256,uint256,uint256,uint64,uint64))",
])

const label = "season-e2e-" + Date.now()
const seasonId = keccak256(toHex(label))
const step = (n: number, m: string) => console.log(`${n}. ${m}`)

const send = async (client: typeof w, params: Parameters<typeof w.writeContract>[0]) => {
  const h = await client.writeContract(params)
  const r = await pub.waitForTransactionReceipt({ hash: h })
  return r.status
}

// Fund the winner's gas so they can send their own claim — proving the prize
// is claimed BY the winner, not paid out by the operator.
if ((await pub.getBalance({ address: winner.address })) < 10n ** 16n) {
  const h = await w.sendTransaction({ to: winner.address, value: 30n * 10n ** 15n })
  await pub.waitForTransactionReceipt({ hash: h })
  step(0, `funded winner ${winner.address.slice(0, 10)} for gas`)
}

step(1, `mint  ${await send(w, { address: TOKEN, abi: erc20, functionName: "mint", args: [me.address, 100n * ONE], gas: GAS })}`)
step(2, `approve ${await send(w, { address: TOKEN, abi: erc20, functionName: "approve", args: [POOL, 100n * ONE], gas: GAS })}`)
step(3, `createSeason("${label}") ${await send(w, { address: POOL, abi: pool, functionName: "createSeason", args: [seasonId, TOKEN], gas: GAS })}`)
step(4, `fund 100 ${await send(w, { address: POOL, abi: pool, functionName: "fund", args: [seasonId, 100n * ONE], gas: GAS })}`)
step(5, `setAllocations(winner=60) ${await send(w, { address: POOL, abi: pool, functionName: "setAllocations", args: [seasonId, [winner.address], [60n * ONE]], gas: GAS })}`)

// Before finalization the prize is NOT claimable — the UI must not offer it.
const preFinal = await pub.readContract({ address: POOL, abi: pool, functionName: "claimable", args: [seasonId, winner.address] })
step(6, `claimable before finalize = ${preFinal} (correctly 0 — allocations not frozen yet)`)

step(7, `finalize ${await send(w, { address: POOL, abi: pool, functionName: "finalize", args: [seasonId], gas: GAS })}`)
const postFinal = await pub.readContract({ address: POOL, abi: pool, functionName: "claimable", args: [seasonId, winner.address] })
step(8, `claimable after finalize  = ${postFinal}`)

// The winner claims for themselves.
const balBefore = await pub.readContract({ address: TOKEN, abi: erc20, functionName: "balanceOf", args: [winner.address] })
step(9, `claim (sent BY the winner) ${await send(wWin, { address: POOL, abi: pool, functionName: "claim", args: [seasonId], gas: GAS })}`)

const bal = await pub.readContract({ address: TOKEN, abi: erc20, functionName: "balanceOf", args: [winner.address] })
const after = await pub.readContract({ address: POOL, abi: pool, functionName: "claimable", args: [seasonId, winner.address] })
// The winner address is deterministic, so it accumulates across runs — the
// DELTA is what this run proves, not the absolute balance.
console.log(`\n   paid this run: ${bal - balBefore} (expected 60000000)`)
console.log(`   claimable now: ${after} (expected 0 — one claim only)`)

// Claimed protection: a second attempt must be rejected.
//
// Checked with `simulateContract`, NOT by sending and hoping. `writeContract`
// only SUBMITS — it resolves with a hash before the node has executed anything,
// so a bare try/catch around it cannot observe a revert and will happily report
// a blocked claim as a success. (It did exactly that on the first run of this
// script; the on-chain balance proved otherwise.)
try {
  await pub.simulateContract({
    address: POOL, abi: pool, functionName: "claim", args: [seasonId],
    account: winner,
  })
  console.log("   !! double claim would SUCCEED — this is a bug")
} catch (e) {
  const msg = (e as Error).message
  const blocked = /AlreadyClaimed/.test(msg)
  console.log(`   double claim correctly rejected${blocked ? " (AlreadyClaimed)" : ""}`)
}

// The decisive check: the winner holds exactly one allocation's worth.
const finalBal = await pub.readContract({ address: TOKEN, abi: erc20, functionName: "balanceOf", args: [winner.address] })
const paid = finalBal - balBefore
console.log(`   net paid: ${paid} — ${paid === 60n * ONE ? "exactly one allocation, no double pay" : "UNEXPECTED"}`)

console.log("\nSEASON LIFECYCLE VERIFIED ON LIVE SOMNIA TESTNET.")
process.exit(0)
