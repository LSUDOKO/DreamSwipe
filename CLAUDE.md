# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

DreamSwipe is a Tinder-style PvP prediction duel on **Somnia** (Shannon
testnet, chain **50312**) built on **DreamDEX Event Contracts**. Two players
swipe YES/NO through a 3–5 card deck of live binary markets; a Solidity
`DreamSwipeDuel` contract escrows stakes and pays the winner.

It began as Flicky (Sui + DeepBook Predict). `docs/MIGRATION_AUDIT.md` records
what was reused versus replaced, and is the reference for why the codebase
looks the way it does.

## Stack

Bun workspaces + Turborepo.

- `apps/web` — Vite + React 19 + Tailwind v4 + shadcn/ui + **wagmi/viem**.
- `apps/server` — Bun runtime. WS relay, matchmaking, deckmaster, **relayer**,
  **Somnia keeper**, Bot Arena API, MMR + leaderboard. Uses `Bun.*` directly
  (including `Bun.sql`, no ORM).
- `apps/contracts-evm` — Foundry. `DreamSwipeDuel.sol`, solc 0.8.24,
  `evm_version = cancun`.
- `packages/dreamdex` — the venue boundary: types, CLOB math, Bot Arena agents,
  and the Somnia adapter.
- `packages/ui` — shared shadcn components and `globals.css`.

## Commands

Always `bun` (≥ 1.3), never npm/pnpm/yarn.

```bash
bun install
bun dev                       # web + server
bun typecheck                 # 6 packages
bun run test                  # turbo test (raw `bun test` wanders into vendored clones)
bun build

bun --filter server run check:dreamdex   # live venue health check, no key needed
bun --filter server run e2e:somnia       # full lifecycle on live testnet (needs a funded key)
```

**Foundry:** `forge` on this machine is shadowed by an unrelated CLI of the same
name. Use `~/.config/.foundry/bin/forge`.

```bash
cd apps/contracts-evm
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
git clone --depth 1 -b v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
forge test
```

## Load-bearing constraints

These are not stylistic. Each one is here because getting it wrong fails
silently.

- **Never hardcode collateral decimals.** Shannon testnet is **tUSDC at 6
  decimals**; mainnet USDso is 18. The two differ by 10¹² and *nothing reverts*
  to tell you. Read `decimals()` or use the market's own `collateralDecimals`.
- **Price = probability in millionths**, always quoted in UP/YES terms. A DOWN
  price is `ONE − up`. The single conversion point is `toUpPrice`.
- **Only `packages/dreamdex` may import the venue SDK.** The web app imports
  the package root (browser-safe); server-only code imports
  `@workspace/dreamdex/adapter`, which pulls in `node:*` and the SDK.
- **Discovery must not depend on the indexer.** Markets are found by scanning
  `MarketCreated` logs on chain. This repo already lost ~12 days to a
  third-party read API being torn down.
- **Never fabricate venue data.** Anything underivable returns `null`, never
  `0`. No synthesized tx hashes, order ids, fills or prices — throw
  `VenueUnavailableError` instead. `getFills` throws rather than returning `[]`,
  because an empty array cannot be distinguished from "not implemented".
- **Free and Staked tiers share one code path.** The tier gates only whether
  collateral moves. A Free duel carrying a stake reverts on chain.
- **Deck size is `clamp(eligible, 3, 5)` and never padded.** Below 3 eligible
  markets the card source throws — two cards on the same market would show the
  same question twice and settle identically.
- **Swipes are EIP-712 signatures, not transactions.** The player signs; the
  relayer submits and pays. The signature binds
  `(duelId, cardIdx, direction, nonce, deadline)`, so the relayer can neither
  forge nor replay one, and cannot touch escrow.
- **`premium`/`filled` are derived server-side from the live venue**, never
  taken from the request body — a client-supplied premium would let a player
  understate their entry cost and inflate their own PnL.
- **Bot fairness is structural.** `PredictionContext` has no outcome field, so
  an agent cannot cheat even in principle. A test pins its exact key set.

## Somnia gas

State creation is priced far above Ethereum, and the failure mode is nasty: an
under-limit transaction **mines with `status: 0` and burns the entire limit**,
while `eth_call` simulation still succeeds — so simulation cannot catch it.

The `DreamSwipeDuel` deploy needed **38.8M gas against a 3.4M estimate (11×)**.
Always estimate or over-provision; unused gas is refunded on success.

## Code style

- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, width
  80. Tailwind plugin sorts classes.
- TypeScript `strict: true`, `moduleResolution: bundler`, `target: ES2022`.
- **`erasableSyntaxOnly` is on.** No TS `enum`s and no constructor parameter
  properties — use `const` objects with a matching type, and explicit fields.
- Server is ESM and runs via `bun --hot src/index.ts`. Prefer `Bun.*` APIs.
- `packages/ui` omits `eslint-plugin-react-refresh` on purpose (it is a
  library) — don't add it back.

## Secrets

Never commit a key. `.env` is gitignored; `.env.example` documents every var.
The relayer and keeper read `RELAYER_PRIVATE_KEY` / `KEEPER_PRIVATE_KEY` and
no-op cleanly when unset, so a read-only deployment boots fine.
