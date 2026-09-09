/**
 * Regenerate `src/lib/duel-abi.ts` from the Foundry build artifact.
 *
 * Keeping the ABI generated rather than hand-written means a contract change
 * cannot silently drift from the client: recompile, re-run this, and any call
 * site that no longer typechecks is a real break.
 *
 *   cd apps/contracts-evm && forge build
 *   bun run scripts/gen-abi.ts
 */
const ARTIFACT =
  "../contracts-evm/out/DreamSwipeDuel.sol/DreamSwipeDuel.json"
const OUT = "src/lib/duel-abi.ts"

const artifact = await Bun.file(new URL(ARTIFACT, import.meta.url)).json()

const header = `/**
 * DreamSwipeDuel ABI.
 *
 * GENERATED from \`apps/contracts-evm/out/DreamSwipeDuel.sol/DreamSwipeDuel.json\`.
 * Do not hand-edit: recompile the contract and re-run the codegen instead, or
 * the app will encode calls against a signature the chain no longer has.
 *
 *   cd apps/contracts-evm && forge build
 *   bun run scripts/gen-abi.ts
 */
export const duelAbi = `

await Bun.write(
  new URL(OUT, import.meta.url),
  header + JSON.stringify(artifact.abi, null, 2) + " as const\n"
)
console.log(`wrote ${artifact.abi.length} ABI entries to ${OUT}`)
