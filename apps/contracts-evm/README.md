# DreamSwipe contracts (Somnia / EVM)

Solidity port of the Move `flicky::duel` module, targeting Somnia Shannon
testnet (chain **50312**).

## Setup

Dependencies are vendored via git rather than committed:

```bash
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
git clone --depth 1 -b v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
```

## Commands

```bash
forge build
forge test          # 41 tests, incl. a fuzzed escrow-conservation property
forge test -vvv     # with traces
```

## Somnia specifics

- `evm_version = "cancun"` — Somnia's EVM baseline.
- State creation is priced aggressively; **estimate gas, never hardcode
  Ethereum numbers**. A 21k-pinned transfer can mine with status 0 and burn
  the limit.
- EIP-1559 min base fee is ~6 gwei; set `maxFeePerGas` with real headroom.

## Contracts

| Contract | Purpose |
| --- | --- |
| `DreamSwipeDuel.sol` | Duel state machine: escrow, commit-reveal deck, EIP-712 relayed swipes, per-card settlement, payout, refunds. |

### Why swipes are EIP-712 signed and relayed

On Sui, each swipe had to be a player-signed transaction because the venue
required the sender to own the minting account. That constraint does not exist
on Somnia, so a player signs a typed `Swipe` message off-chain — no wallet
popup, no gas — and the relayer submits it. The signature is bound to
`(duelId, cardIdx, direction, nonce, deadline)`, so the relayer can neither
forge nor replay a swipe, and has no path to move escrow.
