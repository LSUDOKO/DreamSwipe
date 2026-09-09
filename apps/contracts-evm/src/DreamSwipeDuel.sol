// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title DreamSwipeDuel
 * @notice Two-player, N-card prediction duel. Escrows both stakes, records
 *         commit-revealed decks and per-card swipes, then settles each card
 *         from keeper-supplied venue evidence and pays the winner.
 *
 * @dev This is the Somnia/EVM port of the Move `flicky::duel` module. The
 *      state machine and its two-phase settlement are carried over deliberately
 *      — that design is battle-tested and solves a real problem:
 *
 *        Each card pins a DIFFERENT prediction market with its own expiry.
 *        Settling them one at a time means a slow market cannot block the
 *        others, and a failed settle for one card cannot roll back the rest.
 *
 *      ── Why swipes are relayed, not self-sent ─────────────────────────────
 *
 *      On Sui, each swipe had to be a player-signed transaction because the
 *      venue required the sender to own the account being minted from. That
 *      constraint does not exist here, so DreamSwipe uses EIP-712: the player
 *      signs a typed `Swipe` message off-chain (no wallet popup, no gas) and a
 *      relayer submits it. The signature is bound to
 *      (duelId, cardIdx, direction, nonce, deadline) so a relayer can neither
 *      forge a swipe nor replay one, and cannot touch funds.
 *
 *      ── Money-flow gating, not code forking ──────────────────────────────
 *
 *      FREE and STAKED tiers run the SAME code path. The tier only gates
 *      whether collateral moves. Forking the engine per tier is how the two
 *      diverge and one of them rots.
 *
 *      ── Scoring ───────────────────────────────────────────────────────────
 *
 *      Score is realized economics, never an arbitrary multiplier:
 *
 *          cardPnl   = payout - premium        (per player, per card)
 *          duelScore = sum(cardPnl)
 *
 *      A winning binary contract redeems 1:1 with collateral; a losing one is
 *      worth zero; a voided market refunds both sides at half. Those are the
 *      only payout shapes, and they come from the venue, not from us.
 */
contract DreamSwipeDuel is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────────

    enum Status {
        None, // 0 — never created
        Pending, // 1 — creator staked, waiting for a challenger
        Active, // 2 — both staked; deck revealed, swipes in progress
        Complete // 3 — finalized, refunded, or cancelled
    }

    enum Tier {
        Free, // no collateral moves
        Staked // both players escrow `stake`
    }

    /** @dev Which side a player took on a card. */
    enum Direction {
        Up,
        Down
    }

    /**
     * @notice One card: a pointer to a venue market plus the strike it was
     *         dealt at.
     * @dev `marketId` is the venue's own bytes32 id. The strike is stored
     *      because the venue may express a question relative to the window's
     *      opening price, which is not recoverable later.
     */
    struct Card {
        bytes32 marketId;
        uint256 strike;
    }

    /**
     * @notice A recorded swipe.
     * @dev `premium` is what the player actually paid to enter, in collateral
     *      base units — the `actualEntryCost` term of the score. `filled` is
     *      the size acquired; a partial fill scores on what was really
     *      obtained, never on what was requested.
     */
    struct Swipe {
        bool exists;
        Direction direction;
        uint128 premium;
        uint128 filled;
    }

    struct Duel {
        Status status;
        Tier tier;
        address creator;
        address challenger;
        address stakeToken;
        uint128 stake;
        uint8 deckSize;
        uint8 settledCount;
        bool deckRevealed;
        bytes32 deckCommit;
        uint64 createdAtSec;
        uint64 startedAtSec;
        // Accumulated realized economics, summed across settled cards.
        int256 p0Score;
        int256 p1Score;
    }

    // ─── Constants ──────────────────────────────────────────────────────────

    uint8 public constant MIN_DECK_SIZE = 3;
    uint8 public constant MAX_DECK_SIZE = 5;

    /**
     * @notice How long a creator has to reveal the deck before the challenger
     *         can reclaim their stake.
     * @dev Without this a creator who dislikes the revealed deck could simply
     *      never reveal, stranding the challenger's collateral forever.
     */
    uint64 public constant REVEAL_TIMEOUT_SEC = 5 minutes;

    /**
     * @notice How long after start the duel can be force-refunded if it never
     *         completed (venue outage, abandoned opponent).
     * @dev Escrow must never be permanently trapped by an external failure.
     */
    uint64 public constant DUEL_TIMEOUT_SEC = 2 hours;

    /// @dev EIP-712 typehash for a relayed swipe.
    bytes32 private constant SWIPE_TYPEHASH = keccak256(
        "Swipe(bytes32 duelId,uint8 cardIdx,uint8 direction,uint256 nonce,uint256 deadline)"
    );

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The settlement keeper: may reveal decks and settle cards.
    address public keeper;

    /// @notice Contract admin: may rotate the keeper.
    address public admin;

    mapping(bytes32 => Duel) private _duels;
    /// @dev duelId => cards. Empty until reveal.
    mapping(bytes32 => Card[]) private _decks;
    /// @dev duelId => player => cardIdx => swipe.
    mapping(bytes32 => mapping(address => mapping(uint8 => Swipe))) private _swipes;
    /// @dev duelId => cardIdx => settled.
    mapping(bytes32 => mapping(uint8 => bool)) private _cardSettled;
    /// @dev Per-player EIP-712 nonce. Strictly increasing; blocks replay.
    mapping(address => uint256) public nonces;
    /// @dev Monotonic counter feeding duel id derivation.
    uint256 private _duelSeq;

    // ─── Events ─────────────────────────────────────────────────────────────

    event DuelCreated(
        bytes32 indexed duelId,
        address indexed creator,
        Tier tier,
        address stakeToken,
        uint128 stake,
        uint8 deckSize,
        bytes32 deckCommit
    );
    event DuelJoined(bytes32 indexed duelId, address indexed challenger, uint64 startedAtSec);
    event DeckRevealed(bytes32 indexed duelId, bytes32[] marketIds, uint256[] strikes);
    event SwipeRecorded(
        bytes32 indexed duelId,
        address indexed player,
        uint8 indexed cardIdx,
        Direction direction,
        uint128 premium,
        uint128 filled
    );
    event CardSettled(
        bytes32 indexed duelId,
        uint8 indexed cardIdx,
        bytes32 marketId,
        int256 p0Pnl,
        int256 p1Pnl
    );
    event DuelFinalized(
        bytes32 indexed duelId,
        address indexed winner,
        int256 p0Score,
        int256 p1Score,
        uint256 payout
    );
    event DuelRefunded(bytes32 indexed duelId, uint8 reason);
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);

    // ─── Errors ─────────────────────────────────────────────────────────────

    error NotKeeper();
    error NotAdmin();
    error NotPlayer();
    error DuelNotPending();
    error DuelNotActive();
    error DuelNotComplete();
    error AlreadyJoined();
    error CreatorCannotJoin();
    error InvalidDeckSize();
    error InvalidDeckCommit();
    error DeckAlreadyRevealed();
    error DeckNotRevealed();
    error DeckCommitMismatch();
    error CardIndexOutOfBounds();
    error AlreadySwiped();
    error CardAlreadySettled();
    error CardsNotAllSettled();
    error ZeroStake();
    error StakeMustBeZeroForFreeTier();
    error SignatureExpired();
    error InvalidSignature();
    error InvalidNonce();
    error TimeoutNotReached();
    error ZeroAddress();

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address keeper_) EIP712("DreamSwipeDuel", "1") {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        admin = msg.sender;
        emit KeeperUpdated(address(0), keeper_);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /**
     * @notice Rotate the keeper.
     * @dev Deliberately narrow: the keeper can reveal decks and settle cards,
     *      but has no path to move escrow to an arbitrary address. Payouts are
     *      computed from recorded swipes and go only to the two players.
     */
    function setKeeper(address newKeeper) external onlyAdmin {
        if (newKeeper == address(0)) revert ZeroAddress();
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * @notice Open a duel and escrow the creator's stake.
     * @param deckCommit Hash of the deck, committed BEFORE reveal so the deck
     *        cannot be reshuffled once players can see it.
     * @param deckSize Number of cards; must match the revealed deck exactly.
     * @param stakeToken Collateral token. Ignored for the Free tier.
     * @param stake Amount each player escrows. Must be 0 for the Free tier.
     */
    function createDuel(
        bytes32 deckCommit,
        uint8 deckSize,
        Tier tier,
        address stakeToken,
        uint128 stake
    ) external nonReentrant returns (bytes32 duelId) {
        if (deckCommit == bytes32(0)) revert InvalidDeckCommit();
        if (deckSize < MIN_DECK_SIZE || deckSize > MAX_DECK_SIZE) revert InvalidDeckSize();

        if (tier == Tier.Staked) {
            if (stake == 0) revert ZeroStake();
            if (stakeToken == address(0)) revert ZeroAddress();
        } else if (stake != 0) {
            // A Free duel that moved money would be a silent tier violation.
            revert StakeMustBeZeroForFreeTier();
        }

        unchecked {
            _duelSeq++;
        }
        duelId = keccak256(abi.encodePacked(block.chainid, address(this), _duelSeq, msg.sender));

        _duels[duelId] = Duel({
            status: Status.Pending,
            tier: tier,
            creator: msg.sender,
            challenger: address(0),
            stakeToken: tier == Tier.Staked ? stakeToken : address(0),
            stake: stake,
            deckSize: deckSize,
            settledCount: 0,
            deckRevealed: false,
            deckCommit: deckCommit,
            createdAtSec: uint64(block.timestamp),
            startedAtSec: 0,
            p0Score: 0,
            p1Score: 0
        });

        if (tier == Tier.Staked) {
            IERC20(stakeToken).safeTransferFrom(msg.sender, address(this), stake);
        }

        emit DuelCreated(duelId, msg.sender, tier, stakeToken, stake, deckSize, deckCommit);
    }

    /**
     * @notice Join a pending duel, matching the creator's stake.
     */
    function joinDuel(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Pending) revert DuelNotPending();
        if (d.challenger != address(0)) revert AlreadyJoined();
        if (msg.sender == d.creator) revert CreatorCannotJoin();

        d.challenger = msg.sender;
        d.status = Status.Active;
        d.startedAtSec = uint64(block.timestamp);

        if (d.tier == Tier.Staked) {
            IERC20(d.stakeToken).safeTransferFrom(msg.sender, address(this), d.stake);
        }

        emit DuelJoined(duelId, msg.sender, d.startedAtSec);
    }

    /**
     * @notice Reveal the committed deck.
     * @dev The commit is `keccak256(abi.encode(marketIds, strikes, salt))`.
     *      Recomputing and comparing it here is what makes the deck provably
     *      un-reshuffled: the server cannot see both players' preferences and
     *      then choose a favourable deck, because it was bound at creation.
     *
     *      The salt prevents brute-forcing the commit from the small space of
     *      plausible decks.
     */
    function revealDeck(
        bytes32 duelId,
        bytes32[] calldata marketIds,
        uint256[] calldata strikes,
        bytes32 salt
    ) external onlyKeeper {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (d.deckRevealed) revert DeckAlreadyRevealed();
        if (marketIds.length != d.deckSize || strikes.length != d.deckSize) {
            revert InvalidDeckSize();
        }
        if (keccak256(abi.encode(marketIds, strikes, salt)) != d.deckCommit) {
            revert DeckCommitMismatch();
        }

        Card[] storage deck = _decks[duelId];
        for (uint256 i = 0; i < marketIds.length; i++) {
            deck.push(Card({marketId: marketIds[i], strike: strikes[i]}));
        }
        d.deckRevealed = true;

        emit DeckRevealed(duelId, marketIds, strikes);
    }

    /**
     * @notice Record a swipe the player authorized off-chain via EIP-712.
     * @dev Called by the relayer, so the player never sees a wallet popup and
     *      pays no gas. Security rests entirely on the signature being bound to
     *      every parameter that matters:
     *
     *        - duelId + cardIdx  → cannot be moved to another duel or card
     *        - direction         → cannot be flipped
     *        - nonce             → cannot be replayed
     *        - deadline          → cannot be held and submitted later
     *
     *      `premium` and `filled` are supplied by the relayer because they are
     *      venue execution facts the player cannot know at signing time. That
     *      is a deliberate trust boundary: a dishonest relayer could misreport
     *      a player's entry cost, so those values are cross-checked against
     *      venue evidence off-chain, and the keeper is the party accountable
     *      for them. It cannot steal funds — only the two players can ever
     *      receive escrow.
     */
    function recordSwipe(
        bytes32 duelId,
        address player,
        uint8 cardIdx,
        Direction direction,
        uint128 premium,
        uint128 filled,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyKeeper {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (!d.deckRevealed) revert DeckNotRevealed();
        if (cardIdx >= d.deckSize) revert CardIndexOutOfBounds();
        if (player != d.creator && player != d.challenger) revert NotPlayer();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (_swipes[duelId][player][cardIdx].exists) revert AlreadySwiped();

        // Strictly sequential nonces: a gap would let a skipped signature be
        // replayed later, and reuse is rejected outright.
        if (nonce != nonces[player]) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(SWIPE_TYPEHASH, duelId, cardIdx, uint8(direction), nonce, deadline)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != player) revert InvalidSignature();

        unchecked {
            nonces[player] = nonce + 1;
        }

        _swipes[duelId][player][cardIdx] =
            Swipe({exists: true, direction: direction, premium: premium, filled: filled});

        emit SwipeRecorded(duelId, player, cardIdx, direction, premium, filled);
    }

    /**
     * @notice Settle one card from venue evidence and accrue both scores.
     * @param winner Winning side for this market.
     * @param voided True if the venue voided the market, in which case BOTH
     *        sides redeem at half rather than one side taking everything.
     *
     * @dev Phase 1 of finalization, one card at a time — see the contract
     *      docstring for why. Idempotent by `_cardSettled`: a card can never be
     *      scored twice, which is the invariant that stops a duel from being
     *      inflated by repeated settlement of the same market.
     */
    function settleCard(bytes32 duelId, uint8 cardIdx, Direction winner, bool voided)
        external
        onlyKeeper
    {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (!d.deckRevealed) revert DeckNotRevealed();
        if (cardIdx >= d.deckSize) revert CardIndexOutOfBounds();
        if (_cardSettled[duelId][cardIdx]) revert CardAlreadySettled();

        _cardSettled[duelId][cardIdx] = true;
        unchecked {
            d.settledCount++;
        }

        int256 p0Pnl = _scoreSwipe(_swipes[duelId][d.creator][cardIdx], winner, voided);
        int256 p1Pnl = _scoreSwipe(_swipes[duelId][d.challenger][cardIdx], winner, voided);

        d.p0Score += p0Pnl;
        d.p1Score += p1Pnl;

        emit CardSettled(duelId, cardIdx, _decks[duelId][cardIdx].marketId, p0Pnl, p1Pnl);
    }

    /**
     * @dev Realized PnL for one swipe: `payout - premium`.
     *
     *      A player who never swiped a card scores exactly zero — they neither
     *      paid nor received. Treating a missing swipe as a loss would punish
     *      a player for a card the venue or relayer failed to serve.
     */
    function _scoreSwipe(Swipe storage s, Direction winner, bool voided)
        private
        view
        returns (int256)
    {
        if (!s.exists) return 0;

        uint256 payout;
        if (voided) {
            // Voided markets refund both sides at 0.5.
            payout = uint256(s.filled) / 2;
        } else if (s.direction == winner) {
            // A winning contract redeems 1:1 with collateral.
            payout = uint256(s.filled);
        } else {
            payout = 0;
        }

        return int256(payout) - int256(uint256(s.premium));
    }

    /**
     * @notice Finalize a duel once every card is settled, and pay out.
     * @dev Phase 2. Higher summed realized PnL wins the whole pot; an exact
     *      tie returns each player their own stake rather than picking a
     *      winner arbitrarily.
     */
    function finalize(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (d.settledCount != d.deckSize) revert CardsNotAllSettled();

        d.status = Status.Complete;

        address winner;
        uint256 payout;

        if (d.tier == Tier.Staked) {
            uint256 pot = uint256(d.stake) * 2;
            if (d.p0Score > d.p1Score) {
                winner = d.creator;
                payout = pot;
                IERC20(d.stakeToken).safeTransfer(d.creator, pot);
            } else if (d.p1Score > d.p0Score) {
                winner = d.challenger;
                payout = pot;
                IERC20(d.stakeToken).safeTransfer(d.challenger, pot);
            } else {
                // Draw: each player takes back exactly their own stake.
                IERC20(d.stakeToken).safeTransfer(d.creator, d.stake);
                IERC20(d.stakeToken).safeTransfer(d.challenger, d.stake);
            }
        } else {
            if (d.p0Score > d.p1Score) winner = d.creator;
            else if (d.p1Score > d.p0Score) winner = d.challenger;
        }

        emit DuelFinalized(duelId, winner, d.p0Score, d.p1Score, payout);
    }

    // ─── Refunds ────────────────────────────────────────────────────────────

    /**
     * @notice Cancel a duel nobody joined and return the creator's stake.
     */
    function cancelPending(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Pending) revert DuelNotPending();
        if (msg.sender != d.creator) revert NotPlayer();

        d.status = Status.Complete;
        if (d.tier == Tier.Staked) {
            IERC20(d.stakeToken).safeTransfer(d.creator, d.stake);
        }
        emit DuelRefunded(duelId, 0);
    }

    /**
     * @notice Refund both players when the deck was never revealed in time.
     * @dev Closes the griefing vector where a creator stalls forever after
     *      seeing a deck they dislike, freezing the challenger's collateral.
     *      Permissionless on purpose — the challenger must not need the
     *      creator's cooperation to get their money back.
     */
    function claimRevealTimeout(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (d.deckRevealed) revert DeckAlreadyRevealed();
        if (block.timestamp < d.startedAtSec + REVEAL_TIMEOUT_SEC) revert TimeoutNotReached();

        d.status = Status.Complete;
        _refundBoth(d);
        emit DuelRefunded(duelId, 1);
    }

    /**
     * @notice Refund both players when a started duel never completed.
     * @dev The backstop for a venue outage or an abandoned opponent. Escrow
     *      must never be permanently trapped by a third party's failure — the
     *      exact scenario this project already lived through once when an
     *      upstream venue was torn down mid-flight.
     */
    function claimDuelTimeout(bytes32 duelId) external nonReentrant {
        Duel storage d = _duels[duelId];
        if (d.status != Status.Active) revert DuelNotActive();
        if (block.timestamp < d.startedAtSec + DUEL_TIMEOUT_SEC) revert TimeoutNotReached();

        d.status = Status.Complete;
        _refundBoth(d);
        emit DuelRefunded(duelId, 2);
    }

    function _refundBoth(Duel storage d) private {
        if (d.tier != Tier.Staked) return;
        IERC20(d.stakeToken).safeTransfer(d.creator, d.stake);
        if (d.challenger != address(0)) {
            IERC20(d.stakeToken).safeTransfer(d.challenger, d.stake);
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function getDuel(bytes32 duelId) external view returns (Duel memory) {
        return _duels[duelId];
    }

    function getDeck(bytes32 duelId) external view returns (Card[] memory) {
        return _decks[duelId];
    }

    function getSwipe(bytes32 duelId, address player, uint8 cardIdx)
        external
        view
        returns (Swipe memory)
    {
        return _swipes[duelId][player][cardIdx];
    }

    function isCardSettled(bytes32 duelId, uint8 cardIdx) external view returns (bool) {
        return _cardSettled[duelId][cardIdx];
    }

    /// @notice The EIP-712 digest a player must sign to authorize a swipe.
    function swipeDigest(
        bytes32 duelId,
        uint8 cardIdx,
        Direction direction,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(SWIPE_TYPEHASH, duelId, cardIdx, uint8(direction), nonce, deadline)
            )
        );
    }

    /// @notice Recompute a deck commitment. Used by the server before creating.
    function computeDeckCommit(
        bytes32[] calldata marketIds,
        uint256[] calldata strikes,
        bytes32 salt
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(marketIds, strikes, salt));
    }
}
