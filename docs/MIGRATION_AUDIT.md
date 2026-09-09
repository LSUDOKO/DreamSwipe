# DreamSwipe — Migration Audit

**Date:** 2026-09-09
**Source project:** Flicky (Sui + DeepBook Predict)
**Target project:** DreamSwipe (Somnia + DreamDEX)
**Status of this document:** Phase 1 deliverable, per `specs/10_CLAUDE_EXECUTION_CHECKLIST.md`.

This audit is written before any code changes, per Absolute Rule #1 of the master
spec. It records what exists, what is reusable, what is Sui-specific, what
external assumptions in the spec pack are **verified** versus **unverified**, and
where the migration boundaries fall.

---

## 1. Baseline: the repository as found

The existing repo is not a scaffold. It is a substantially complete, working
game with real tests.

Measured at audit time:

| Metric | Value |
| --- | --- |
| TypeScript / TSX / Move source files | 212 |
| Lines of code (ts, tsx, move) | 55,153 |
| `bun typecheck` | **passes** (5/5 packages) |
| `bun test` | **336 pass, 93 skip, 0 fail** (429 tests, 34 files) |
| Package manager | bun 1.3.5 (repo pins `bun@1.3.9`) |

Workspace layout:

```
apps/web         ~20,990 LOC   Vite + React 19 + Tailwind v4 + shadcn/ui
apps/server      ~17,232 LOC   Bun.serve, WS relay, keeper, deckmaster, MMR
apps/contracts    ~3,478 LOC   Move: duel, season prize pool, swap
apps/playground                DeepBook Predict experiment harness
packages/ui                    shared shadcn components
```

**Conclusion:** this is a migration, not a rebuild. The dominant risk is
destroying working game logic, not writing too little new code.

---

## 2. Verified external facts

Per Absolute Rules #4–#7, external claims must be checked, not assumed. Each
row below is marked with how it was verified.

### 2.1 Somnia Shannon testnet — CONFIRMED

Verified by direct JSON-RPC calls made during this audit:

| Claim (from spec) | Result | Evidence |
| --- | --- | --- |
| Chain ID is `50312` | **CONFIRMED** | `eth_chainId` → `0xc488` = 50312 |
| Shannon testnet is live | **CONFIRMED** | `eth_blockNumber` → `0x1cd6e673` (~483M) |
| RPC endpoint reachable | **CONFIRMED** | `https://dream-rpc.somnia.network` responds |
| It is a real EVM chain | **CONFIRMED** | `web3_clientVersion` → `somnia-d151af8758cbbcb-release` |

A second independent endpoint (`https://rpc.ankr.com/somnia_testnet`) returned
the same chain ID, so this is not a single-source result.

Somnia is an **EVM** chain. This is the single most consequential fact in the
migration: the existing chain layer is Sui/Move and cannot be ported, only
replaced. See §4.

### 2.2 DreamDEX Bot Kit — NOT FOUND on public npm

The spec pack states the "modern Bot Kit package" is `@dreamdex-bot-kit/core`.
Queried against the public npm registry during this audit:

| Package name tried | Registry response |
| --- | --- |
| `@dreamdex-bot-kit/core` | **404** |
| `dreamdex-bot-kit` | **404** |
| `@dreamdex/bot-kit` | **404** |
| `@dreamdex/sdk` | **404** |
| `dreamdex` | **404** |

**No DreamDEX SDK is installable from the public npm registry under any of the
obvious names.** This does not prove the package does not exist — it may be
published to a private registry, distributed via GitHub, or named differently —
but it does mean the integration **cannot be built by taking the spec's package
name on faith.**

Per Absolute Rule #5 ("do not invent contract methods, market endpoints, order
APIs...") and Rule #11 ("if an advanced capability is not supported by the live
venue, implement an honest disabled/unavailable state rather than a fake path"),
this drives the central architectural decision in §5.

### 2.3 Facts still unverified

The following spec claims could **not** be independently confirmed at audit time
and must be treated as unverified until a real DreamDEX endpoint is available:

- `placeOrder(...)` as the current order entry point, and its exact signature
- the `Pool` abstraction and its API surface
- USDso contract address (18 decimals is claimed; the *address* is unknown)
- Event Contract market discovery endpoint and market ID representation
- outcome representation and settlement representation
- whether early exit / sell-before-expiry is supported
- WebSocket order-book endpoint URL
- the canonical DreamDEX terminal deep-link URL format

**These are exactly the fields the spec forbids inventing.** Every one of them
is confined behind the adapter interface in §5 so that no game code depends on
a guess.

---

## 3. Reusable code — preserve this

Per Absolute Rule #2. The following is chain-agnostic or near-agnostic and
carries most of the project's real value.

### 3.1 Fully reusable (no chain coupling)

| Area | Files | Why it survives |
| --- | --- | --- |
| WS wire protocol | `ws/protocol.ts` | Typed client/server messages, stake tiers. Already matches the spec's message list closely. |
| Matchmaking | `ws/matchmaking.ts` (667 LOC) + tests | MMR-window queue with tolerance expansion — the spec asks for exactly this. |
| MMR / leaderboard | `mmr.ts` + tests | Elo with K-factor, expanding match window, leaderboard query. |
| Chat | `ws/chat.ts` + tests | Global + room chat, retention/pruning. |
| Deck selection rules | `deckmaster.ts` (1,134 LOC) + 986 LOC of tests | Tiering, zone/sign allocation, seeded determinism, commit-reveal hashing. |
| Practice engine | `use-practice-session.ts` (503 LOC) | Fully simulated duel, no chain. Maps 1:1 to the spec's Practice mode. |
| Swipe UI | `swipe-screen.tsx`, `active-duel.tsx`, `duel-view.tsx` | Gesture handling, card presentation, lockup view. |
| Charts / PnL | `streaming-pnl-chart.tsx`, `pnl.ts`, `pnl-history.ts` | Presentation of realized/projected PnL. |
| Design system | `packages/ui`, all of `apps/web/public` | shadcn components, avatars, sounds, mascot art. |

### 3.2 The most important finding: a venue seam already exists

`apps/server/src/card-source.ts` is the single most valuable file for this
migration. Its own docstring explains why it exists:

> Historically the deck was welded to DeepBook Predict... That made a
> third-party service a single point of failure for the whole game — and on
> 2026-08-17 it failed totally. Predict's 6-24 testnet stopped creating markets,
> its read API was torn down, and both tiers were unplayable for ~12 days.

The team already survived a total venue outage by introducing a `CardSource`
interface with two implementations (`predict`, `pyth`) and an `auto` mode that
falls back. Critically, it is **not a second game**: both sources emit the same
`DeckCardOut[]`, and commit-reveal, swipe, lockup, settle and finalize remain
one code path.

**This is precisely the adapter boundary `specs/04_DREAMDEX_INTEGRATION.md`
demands**, already built, already tested, and already proven against a real
outage. DreamDEX becomes a third `CardSource` implementation rather than a
rewrite. The `NoCardsAvailableError` → fallback path is the honest
"venue unavailable" state Rule #11 asks for.

### 3.3 Reusable with adaptation

| Area | Adaptation needed |
| --- | --- |
| `indexer.ts` (927 LOC) | Event decoding: Sui events → EVM logs. Cursor/idempotency logic survives. |
| `keeper.ts` (733 LOC) | Settlement orchestration survives; chain reads/writes swap out. Its idempotency and terminal-error classification are directly reusable. |
| `sponsor.ts` (581 LOC) | Sponsored gas → session keys / relayer. Same intent, different mechanism. |
| `db.ts` (1,265 LOC) | 10 tables exist. Schema is close to the spec's table list; needs `orders`, `fills`, `bot_matches`, `referrals`, and address-format widening. |

---

## 4. Sui-specific code — must be replaced

28 of ~60 server source files import Sui or reference Predict. The coupling is
concentrated, not diffuse.

### 4.1 Chain layer (full replacement)

| Component | Current | Replacement |
| --- | --- | --- |
| Contracts | Move — `duel.move` (906 LOC), `prize_pool.move`, `swap.move` | Solidity — `DreamSwipeDuel.sol`, `SeasonPrizePool.sol` |
| Contract tests | `duel_tests.move` (1,001 LOC) | Foundry/Hardhat test suite |
| Client SDK | `@mysten/sui`, `@mysten/dapp-kit-react`, `@mysten/enoki` | `viem`, `wagmi`, RainbowKit |
| Codegen | `apps/web/src/sui/gen/**` | ABI-derived types |
| Auth | zkLogin / Enoki | EVM wallet + EIP-712 session keys |
| Gas | Sponsored-gas service | Relayer / session-key authorization |
| Object model | Shared `Duel<T>` object, `ID` types | `duelId` mapping, `address`/`bytes32` |

### 4.2 Sui semantics that do not survive

These are conceptual, not just syntactic, and are where a careless port breaks:

- **Shared-object mutation** — Sui's `Duel<T>` shared object with per-tx locking
  has no EVM equivalent; state transitions become explicit storage writes with a
  reentrancy guard.
- **`Coin<T>` generics** — `create_duel<T>` is generic over the stake coin. EVM
  uses a fixed ERC-20 (USDso) with `SafeERC20`.
- **Sender-owns-account constraint** — the current design forces per-swipe
  player-signed PTBs *because Predict requires the sender to own the minting
  account*. On EVM this constraint is replaced by EIP-712 + a relayer, which is
  what lets us remove the wallet popup per swipe.
- **6-decimal dUSDC → 18-decimal USDso** — every stake tier, premium, quantity
  and PnL constant must be rescaled. `STAKE_TIERS` in `ws/protocol.ts` is
  6-decimal today. This is a silent-corruption risk if missed.

### 4.3 Stale integration assumptions found in-repo

- The repo is pinned to `predict-testnet-8-21` and its own CLAUDE.md notes the
  pin has already moved twice (`4-16` → `6-24` → `8-21`). Confirms the spec's
  warning that venue APIs churn.
- `mint-probe.ts` exists specifically to probe whether markets are actually
  mintable before dealing them — defensive behavior worth carrying to DreamDEX.
- `apps/contracts/deepbook_predict_min/` and `account_min/` are local stubs of
  upstream interfaces; they are Sui-only and get deleted.

---

## 5. Migration boundaries and the adapter decision

### 5.1 The decision

Given §2.2 (no installable DreamDEX SDK found) and Absolute Rules #5/#7/#11, the
integration is structured so that **the game is fully playable and demonstrable
without any unverified venue API**, and DreamDEX slots in behind one interface
the moment its real API is confirmed.

Concretely:

1. `DreamDexAdapter` is defined exactly as specified in the master spec —
   `listMarkets`, `getMarket`, `getOrderBook`, `getQuote`, `placeOrder`,
   `cancelOrder`, `getFills`, `getPosition`, `getSettlement`, `getVenueLink`.
2. It ships with a **live implementation** that is wired to real endpoints, and
   which reports itself unavailable rather than fabricating data when those
   endpoints are not configured or not reachable.
3. Capability flags (`supportsCashOut`, `supportsOrderBook`, ...) drive the UI.
   Cash-out and CLOB panels render an honest disabled state when the venue does
   not actually support them — never a fake number.
4. No component outside `packages/dreamdex` may import venue types directly.

### 5.2 What this explicitly forbids

- inventing a `placeOrder` signature and pretending it settled
- rendering a spread, depth or probability that was not read from a real source
- fabricating tx hashes, order IDs, fills or PnL (Rule #7)
- shimming around a function whose existence is unconfirmed (Rule #6)

### 5.3 Boundary map

```
      web (React)  ──────────────► never imports venue or chain types directly
           │
           ▼
      server (Bun)
        ├── game engine        chain-agnostic: rooms, MMR, chat, deck rules
        ├── CardSource         ◄── existing seam; DreamDEX joins here
        ├── DreamDexAdapter    ◄── the ONLY place venue specifics live
        └── chain client       viem; Somnia Shannon 50312
           │
           ▼
      contracts (Solidity)     escrow, authorization, settlement, payout
```

---

## 6. Missing capabilities (to build)

Relative to the spec pack, these do not exist in the Flicky codebase today:

- `packages/shared`, `packages/dreamdex`, `packages/game-engine` (new packages)
- Solidity contracts + EVM contract test suite + `deployments/<network>.json`
- EIP-712 session keys and the relayer that validates them
- Bot Arena: `PredictionAgent` interface, Momentum / Mean Reversion / CLOB
  Imbalance strategies (a single practice bot exists; a strategy framework does not)
- CLOB intelligence panel (best bid/ask, spread, depth, imbalance)
- Contrarian Edge indicator
- Themed decks (Crypto Turbo / Somnia Ecosystem / High Liquidity)
- Cash-out / early-exit flow
- Seasons UI + claim flow (the Move `prize_pool` exists; the EVM + UI does not)
- Reconciliation worker
- `/health` and `/ready` endpoints
- Docs set: ARCHITECTURE, DEPLOYMENT, SECURITY, DREAMDEX_INTEGRATION,
  BOT_ARENA, SESSION_KEYS, API, TESTING, `.env.example`

---

## 7. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| DreamDEX API unverifiable (§2.2) | **High** | Adapter boundary + honest disabled states; game remains fully playable |
| Decimal migration 6 → 18 | **High** | Centralize all money constants; unit-test conversions |
| Regressing 336 passing tests | **High** | Keep the suite green at every phase; port rather than delete |
| Losing the `CardSource` fallback | Medium | Preserve `auto` fallback semantics for DreamDEX |
| Scope: 12 phases, ~55k LOC base | Medium | Phase order per spec; repo buildable after each |

---

## 8. Conclusion

The Flicky codebase is a strong foundation: the game engine, matchmaking, MMR,
chat, deck logic, practice mode and the entire design system transfer to
DreamSwipe largely intact, and the project already contains a venue-abstraction
seam built in response to a real upstream outage.

The migration's true cost is concentrated in the chain layer — Move → Solidity,
Sui SDK → viem/wagmi, sponsored gas → EIP-712 session keys — plus the decimal
rescale.

The one genuine blocker is that **no DreamDEX SDK or API could be verified from
public sources at audit time.** Rather than guess at it, the integration is
built behind the specified adapter interface with capability-gated, honest
unavailable states, so that nothing in DreamSwipe fabricates venue data and the
real API can be connected without touching game code.
