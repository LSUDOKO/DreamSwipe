# DreamSwipe — Master Implementation Specification

## Mission

Build **DreamSwipe**, the complete evolution of the original Flicky prediction arena for **Somnia + DreamDEX**.

Core experience:

> Two players. One deck. Swipe YES/NO. Read the market. Beat the opponent.

This is a real application, not a UI mockup.

## Absolute rules

1. Audit the existing Flicky repository before changing code.
2. Preserve reusable game/UI logic wherever possible.
3. Remove Sui/Move/DeepBook-specific pieces only where necessary.
4. Use the **current official DreamDEX docs and Bot Kit as the source of truth** for live integration.
5. Do not invent contract methods, market endpoints, order APIs, outcome APIs, URLs, or settlement mechanisms.
6. Do not copy stale DreamDEX examples without checking their current status.
7. Never fake transaction hashes, fills, prices, order IDs, balances, PnL, or settlements.
8. Never commit keys or secrets.
9. Every important game/financial state transition must be tested.
10. Keep the repository buildable after each major phase.
11. If an advanced capability is not supported by the live venue, implement an honest disabled/unavailable state rather than a fake path.
12. Produce documentation for all verified external assumptions.

## Product

### Product name

**DreamSwipe**

Suggested tagline:

**Swipe the market. Beat the crowd.**

### Modes

- Practice: fully simulated, no funds/no chain writes.
- Free PvP: same duel engine, stake = zero.
- Staked PvP: 1v1 duel with supported USDso collateral tiers.
- Bot Arena: human versus DreamDEX-aligned strategy agents.

### Core loop

Landing → Lobby → choose mode/stake/theme → matchmaking → deck commit → reveal → swipe 3–5 cards → lockup → live market view → settlement/cash-out → result → rematch/DreamDEX.

## Complete feature set

### Human PvP

- create duel
- join duel
- room code/deep link
- Free PvP
- Staked PvP
- supported stake tiers
- adaptive 3–5 card deck
- commit-reveal fairness
- authoritative timer
- swipe tracking
- lockup
- settlement
- final payout
- draw handling
- refund paths
- reconnect/recovery

### Practice

- no blockchain dependency
- simulated deck
- Bot_0x
- onboarding
- explain strike, expiry, probability, CLOB, contrarian edge and PnL

### Bot Arena

Initial strategies:

- Momentum
- Mean Reversion
- CLOB Imbalance

Optional advanced adapters:

- Grid
- TWAP
- Market Making

Bots use the same market context abstraction as humans and must never inspect future information.

### CLOB intelligence

Where live data is available, show:

- best bid
- best ask
- spread
- bid depth
- ask depth
- imbalance
- estimated execution price
- liquidity quality
- market probability/price
- time to expiry
- spot vs strike

### Contrarian Edge

Present a market-derived educational indicator, never a guaranteed multiplier.

Example:
- market is strongly YES-weighted
- NO is the less crowded side
- estimated payoff/return for NO is shown from actual pricing

### Themed decks

- Crypto Turbo
- Somnia Ecosystem
- High Liquidity
- optional Custom theme

The backend must perform the filtering.

### DreamDEX handoff

Every relevant market/result can expose:

**Trade on DreamDEX**

Use a verified current terminal/deep-link format. Never assume old URL patterns.

### Cash-out / hedge

Where the actual market supports early exit:

- request current executable quote
- show expected return and slippage
- execute
- verify fill
- calculate realized result
- mark card closed
- prevent double settlement

### Competitive systems

- MMR
- matchmaking tolerance expansion
- win/loss/draw
- streak
- leaderboard
- seasons
- profile
- match history

### Seasonal rewards

- season creation
- funding
- finalization
- allocations
- claims
- claimed protection
- admin controls

### Funding

- balances
- testnet faucet where appropriate
- wallet/approval flow
- optional application swap/funding helper
- clear testnet labels

### Social

- global lobby chat
- room chat
- avatars
- shareable result cards
- rematch
- bot challenge sharing

### UX polish

- Framer Motion swipe physics
- sound effects
- haptics where supported
- loading/error states
- mobile first
- desktop responsive
- transaction status
- reconnect states

---

# Architecture

## Target monorepo

```text
dreamswipe/
├── apps/
│   ├── web/
│   ├── server/
│   └── contracts/
├── packages/
│   ├── ui/
│   ├── shared/
│   ├── dreamdex/
│   └── game-engine/
├── specs/
├── docs/
└── scripts/
```

Adapt the existing repo instead of blindly rebuilding everything.

## Layers

1. React client
2. Bun game server
3. DreamDEX adapter
4. Relayer/operator layer
5. Somnia smart contracts
6. PostgreSQL
7. live WebSocket market feed

## Authority

On-chain is authoritative for:
- escrow
- authorization
- finalized results
- payouts
- settlement state

DreamDEX is authoritative for:
- market data
- orders
- fills
- venue state

Server is authoritative for:
- temporary rooms
- matchmaking
- chat
- cache
- presentation timing

Conflict priority:

`canonical chain/venue evidence > server cache`

---

# Smart contracts

## Core contract

`DreamSwipeDuel.sol`

Responsibilities:

- create
- join
- escrow
- commit deck
- reveal deck
- record authorized swipe
- settlement accounting
- optional cash-out accounting
- finalize
- refund
- timeout

Use:

- OpenZeppelin SafeERC20
- ReentrancyGuard
- EIP-712 or appropriate scoped operator authorization
- explicit state transitions
- replay protection
- deadlines
- spending caps

## Duel states

Recommended:

```solidity
Created
Joined
Revealed
Active
Swiped
Settling
Finalized
Cancelled
```

## Duel data

Track:

- duelId
- playerA
- playerB
- stake
- deck commit
- market identifiers
- card count
- start/create timestamps
- per-card decision
- venue order/fill reference
- premium/cost
- realized result
- cash-out flag
- settlement flag
- total scores
- winner
- authorized session/operator data

## Security invariants

- a player can only swipe their own cards
- one swipe per player/card
- nonces cannot replay
- signature is bound to duel/card/direction/deadline
- session key cannot transfer or withdraw unrelated funds
- a settled card cannot settle again
- a cashed-out card cannot settle again
- refunds are available only after valid timeout
- escrow conservation is preserved
- finalization only happens when the duel is actually complete

## SeasonPrizePool.sol

- create season
- fund season
- finalize allocation
- one-time claim
- admin role separation

## Swap

Only build `SwapAMM.sol` if the application truly needs a custom testnet funding helper. Do not represent it as official DreamDEX liquidity.

---

# DreamDEX integration

## Mandatory abstraction

Create:

```ts
interface DreamDexAdapter {
  listMarkets(filters: MarketFilters): Promise<EventMarket[]>;
  getMarket(marketId: string): Promise<EventMarket>;
  getOrderBook(marketId: string): Promise<OrderBook>;
  getQuote(request: QuoteRequest): Promise<Quote>;
  placeOrder(request: PlaceOrderRequest): Promise<OrderResult>;
  cancelOrder(request: CancelOrderRequest): Promise<CancelResult>;
  getFills(marketId: string, owner?: string): Promise<Fill[]>;
  getPosition(marketId: string, owner: string): Promise<Position>;
  getSettlement(marketId: string): Promise<Settlement | null>;
  getVenueLink(marketId: string, options?: object): string;
}
```

Only the adapter knows DreamDEX-specific details.

## Current integration verification rule

Before implementation, inspect the current official DreamDEX Bot Kit and docs.

The current Bot Kit documentation says:

- Shannon testnet is chain `50312`
- Somnia's native gas token is **SOMI**
- USDso is **18 decimals**
- current DreamDEX order placement uses modern `placeOrder(...)`
- the Bot Kit has a canonical `Pool` API
- current live-book support includes WebSocket plus REST/on-chain reads
- old `placeTakerOrderWithoutVault` examples are stale

Therefore:

**Do not copy old `mintBinaryShares()` / `getOutcome()` examples unless they are confirmed in the current Event Contracts integration.**

## Order lifecycle

```text
resolve market
→ normalize decimals/tick/lot
→ validate liquidity
→ calculate execution constraints
→ funding/allowance check
→ simulation
→ broadcast
→ receipt
→ extract actual order/fill ID
→ observe fill
→ update game state
```

Prefer on-chain fill evidence over potentially lagging convenience trade feeds for PnL.

## Event Contracts caution

Verify the actual current primitive:

- market identifier type
- contract address
- outcome representation
- buy/sell semantics
- expiry
- settlement
- order types
- fill events
- position ownership
- ability to exit before expiry

Create an adapter so changing the venue integration does not require rewriting the game.

---

# Backend

Suggested:

```text
apps/server/src/
├── index.ts
├── config.ts
├── db.ts
├── rooms/
├── matchmaking/
├── deckmaster/
├── dreamdex/
├── relayer/
├── settlement/
├── agents/
├── leaderboard/
├── chat/
├── profiles/
└── telemetry/
```

## WebSocket

Typed client messages:

```ts
Auth
QueueJoin
QueueLeave
DuelReady
Swipe
CashOut
Chat
Heartbeat
```

Typed server messages:

```ts
MatchFound
DeckRevealed
MarketTick
OpponentSwipe
DuelState
Settlement
Result
Error
```

Include:
- protocol version
- event ID
- room ID
- duel ID
- timestamp

## Authoritative clock

Server owns:
- matchmaking timeout
- swipe deadline
- reveal deadline
- room state
- settlement scheduling

Client only renders/interpolates.

## Relayer

Requirements:

- validate typed signature
- verify player/duel/card
- verify nonce
- verify expiry
- verify spend limit
- verify allowed market
- simulate when practical
- submit transaction
- track receipt
- retry safely

## Keeper

Must verify venue evidence before writing settlement.

Store:
- market
- outcome
- fill/position data
- settlement evidence
- source
- transaction hash
- timestamp
- final state

---

# Deckmaster

## Selection

Filter live markets by:

- active
- eligible binary event
- future expiry
- sufficient liquidity
- supported symbol/type
- no duplicate/invalid market

## Adaptive size

```ts
deckSize = clamp(eligibleMarkets.length, 3, 5)
```

If fewer than 3 eligible markets:
- do not fabricate
- show waiting/fallback

## Commit-reveal

Use cryptographically random salt and deterministic canonical encoding.

The same canonical serialization must be used in backend and contract.

---

# Bot Arena

## Interface

```ts
interface PredictionAgent {
  decide(context: PredictionContext): Promise<BotDecision>;
}
```

## Momentum

Use recent price movement/EMA-style inputs.

## Mean reversion

Use:
- spot-vs-strike deviation
- recent volatility
- reversion signal

## CLOB imbalance

```text
imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)
```

Require a minimum data/depth threshold.

## Important

The bot must receive only the information available to a human in that mode. No future outcome access.

Reuse the official Bot Kit strategy/plumbing instead of duplicating venue order logic.

---

# Frontend

## Stack

- React 19
- Vite
- Tailwind
- shadcn/ui
- wagmi
- viem
- RainbowKit or existing wallet stack
- Framer Motion
- Howler or equivalent

## Routes

```text
/
/lobby
/practice
/bot-arena
/duel/:id
/duel/:id/lockup
/duel/:id/result
/leaderboard
/profile/:address
/seasons
/settings
```

## Lobby

Show:
- balance
- mode
- stake
- theme
- matchmaking
- bot arena
- leaderboard
- chat
- funding

## Swipe card

Show:
- market
- event question
- strike
- spot
- expiry
- current price/probability
- CLOB metrics
- YES/NO presentation

Gestures:
- right = YES
- left = NO

Prevent duplicate swipes.

## Lockup

Show:
- live spot
- strike
- countdown
- position status
- projected/realized PnL
- cash-out button only when truly supported
- opponent comparison
- DreamDEX handoff

## Result

Show:
- winner
- score
- pot result
- per-card outcome
- accuracy
- MMR delta
- streak
- share card
- rematch
- DreamDEX link

---

# Session keys

Goal: no wallet popup for each swipe.

Preferred order:

1. Current DreamDEX operator/session-key mechanism where suitable.
2. Otherwise a tightly scoped app session key.

Session authorization must include:
- owner
- duel
- expiry
- max spend
- allowed methods
- allowed markets
- nonce/revocation

Never upload a user's primary wallet private key to the backend.

---

# Cash out

Only enable when the live market supports it.

```text
quote
→ display executable price
→ display slippage
→ authorization/sign
→ execute
→ verify fill
→ compute realized result
→ mark card closed
→ update score
→ block normal settlement
```

Never claim guaranteed profit.

---

# Database

Recommended tables:

- users
- sessions
- player_profiles
- duels
- duel_players
- duel_cards
- orders
- fills
- settlements
- mmr_events
- seasons
- season_rewards
- chat_messages
- bot_profiles
- bot_matches
- referrals

Persist blockchain identifiers for reconciliation.

---

# Security

Threats:
- replay
- session key abuse
- relayer compromise
- malicious client
- fake room
- fake market
- market-data manipulation
- settlement manipulation
- duplicate finalization
- nonce races
- escrow drain
- stale cache

Mitigations:
- EIP-712
- nonce
- deadlines
- per-card binding
- spending caps
- scoped operator permissions
- reentrancy protection
- state machine
- idempotency
- reconciliation

---

# Testing

## Contract

Test:

- creation
- join
- reveal
- invalid reveal
- swipe
- duplicate swipe
- invalid signature
- replay
- settlement
- double settlement
- cash-out
- double cash-out
- timeout
- refund
- draw
- finalization
- reentrancy
- escrow conservation

## Backend

Test:
- queue
- pairing
- websocket auth
- duplicate messages
- races
- reconnect
- nonce conflicts
- relayer errors
- venue failures
- keeper recovery
- reconciliation

## Frontend

Test:
- mobile gestures
- wrong network
- disconnect
- reconnect
- duplicate swipe prevention
- transaction pending
- transaction failure
- no liquidity
- unsupported market

## E2E

Must cover:

```text
login
→ fund
→ create duel
→ join
→ reveal
→ swipe
→ lockup
→ settlement
→ finalize
→ result
```

Also:
- Practice
- Bot Arena
- Free PvP
- timeout
- draw
- cash-out where supported

---

# Deployment

Generate:

```text
deployments/<network>.json
```

with:
- chain ID
- contract addresses
- deploy txs
- deployer
- block number
- timestamp

Create:
- deploy script
- health check
- seed/test script
- verification script

Keep local/testnet environments separate.

---

# Documentation

Must produce:

- README.md
- ARCHITECTURE.md
- DEPLOYMENT.md
- SECURITY.md
- DREAMDEX_INTEGRATION.md
- BOT_ARENA.md
- SESSION_KEYS.md
- API.md
- TESTING.md
- .env.example

---

# Definition of Done

The project is complete only when:

- repo installs
- lint passes
- typecheck passes
- tests pass
- production build passes
- mobile swipe loop works
- duel lifecycle works
- current DreamDEX market integration works for supported markets
- real transaction/fill evidence is displayed when available
- settlement is verified
- Free PvP works
- Practice works
- Bot Arena works
- CLOB metrics work when available
- themed decks work
- DreamDEX handoff works
- cash-out works only on genuinely supported markets
- MMR/leaderboard work
- seasonal claims work
- chat works
- result sharing works
- reconnect works
- refunds/timeouts work
- no secrets are committed
- docs reflect the actual implementation

---

# Claude execution instruction

Start by reading this file and every other file under `./specs/`.

First create:

`docs/MIGRATION_AUDIT.md`

It must identify:
- reusable code
- Sui-specific code
- stale integration assumptions
- missing capabilities
- planned migration boundaries

Then implement in this order:

1. audit
2. shared foundation
3. contracts
4. DreamDEX adapter
5. backend
6. frontend
7. Bot Arena
8. advanced features
9. tests
10. security hardening
11. deployment/docs
12. final verification

Do not stop at scaffolding.

At the end report:
- implemented features
- changed files
- tests and results
- build results
- live integration checks
- genuine blockers
