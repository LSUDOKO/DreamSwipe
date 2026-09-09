// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SeasonPrizePool
 * @notice Escrows a season's prize pool and pays out per-player allocations
 *         that each winner claims exactly once.
 *
 * @dev The lifecycle is deliberately one-way:
 *
 *      Open  → anyone may fund; the operator may set allocations
 *      Final → allocations frozen; winners claim
 *
 *      ── Why finalization is irreversible ──────────────────────────────────
 *
 *      Once a season is finalized the operator can no longer change who gets
 *      what. Without that, "your allocation" would be a promise the operator
 *      could rewrite after a player had already read it — and an operator who
 *      can rewrite allocations after seeing the leaderboard can pay whoever
 *      they like. Freezing is the whole point of escrowing on chain rather
 *      than just paying out from a wallet.
 *
 *      ── Why allocations must fit the balance ──────────────────────────────
 *
 *      `finalize` refuses if the promised total exceeds the escrowed balance.
 *      Allowing it would create a race where early claimants are paid and
 *      later ones silently revert on an empty pool — the worst possible
 *      failure, because it looks like a bug in the claimer's own wallet.
 *
 *      ── Rescue is bounded, not a backdoor ─────────────────────────────────
 *
 *      The operator can only withdraw the SURPLUS above outstanding
 *      allocations, and only after finalization. Funds owed to a winner can
 *      never be pulled out from under them, however long they take to claim.
 */
contract SeasonPrizePool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum SeasonState {
        None, // never created
        Open, // funding + allocation
        Finalized // allocations frozen, claims open
    }

    struct Season {
        SeasonState state;
        address token;
        /// Total collateral deposited into this season.
        uint256 funded;
        /// Sum of every allocation set so far.
        uint256 allocated;
        /// Sum of everything already claimed.
        uint256 claimed;
        uint64 createdAtSec;
        uint64 finalizedAtSec;
    }

    /// @notice Contract owner: creates seasons and rotates the operator.
    address public owner;

    /**
     * @notice Operator: sets allocations and finalizes.
     * @dev Separated from `owner` so the key that runs the leaderboard job is
     *      not the same key that can create seasons or rotate roles. Neither
     *      role can take funds owed to a winner.
     */
    address public operator;

    mapping(bytes32 => Season) private _seasons;
    /// @dev seasonId => player => allocation.
    mapping(bytes32 => mapping(address => uint256)) private _allocation;
    /// @dev seasonId => player => claimed.
    mapping(bytes32 => mapping(address => bool)) private _claimed;

    event SeasonCreated(bytes32 indexed seasonId, address indexed token);
    event SeasonFunded(bytes32 indexed seasonId, address indexed from, uint256 amount);
    event AllocationSet(bytes32 indexed seasonId, address indexed player, uint256 amount);
    event SeasonFinalized(bytes32 indexed seasonId, uint256 allocated, uint256 funded);
    event PrizeClaimed(bytes32 indexed seasonId, address indexed player, uint256 amount);
    event SurplusWithdrawn(bytes32 indexed seasonId, address indexed to, uint256 amount);
    event OperatorUpdated(address indexed previous, address indexed next);

    error NotOwner();
    error NotOperator();
    error SeasonExists();
    error SeasonNotOpen();
    error SeasonNotFinalized();
    error SeasonUnknown();
    error ZeroAddress();
    error ZeroAmount();
    error NothingAllocated();
    error AlreadyClaimed();
    error AllocationsExceedFunding(uint256 allocated, uint256 funded);
    error ArrayLengthMismatch();
    error InsufficientSurplus();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        operator = operator_;
        emit OperatorUpdated(address(0), operator_);
    }

    function setOperator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, next);
        operator = next;
    }

    /**
     * @notice Open a new season.
     * @param seasonId Caller-chosen id, e.g. keccak256("season-1").
     */
    function createSeason(bytes32 seasonId, address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_seasons[seasonId].state != SeasonState.None) revert SeasonExists();

        _seasons[seasonId] = Season({
            state: SeasonState.Open,
            token: token,
            funded: 0,
            allocated: 0,
            claimed: 0,
            createdAtSec: uint64(block.timestamp),
            finalizedAtSec: 0
        });
        emit SeasonCreated(seasonId, token);
    }

    /**
     * @notice Add collateral to an open season.
     * @dev Permissionless on purpose — a sponsor topping up a prize pool needs
     *      no privileges, and gating it would only add an operator round-trip.
     */
    function fund(bytes32 seasonId, uint256 amount) external nonReentrant {
        Season storage s = _seasons[seasonId];
        if (s.state != SeasonState.Open) revert SeasonNotOpen();
        if (amount == 0) revert ZeroAmount();

        s.funded += amount;
        IERC20(s.token).safeTransferFrom(msg.sender, address(this), amount);
        emit SeasonFunded(seasonId, msg.sender, amount);
    }

    /**
     * @notice Set (or overwrite) allocations while the season is still open.
     * @dev Overwriting is allowed BEFORE finalization so a leaderboard can be
     *      recomputed; `allocated` is adjusted by the delta rather than
     *      re-added, or a corrected allocation would double-count against the
     *      funding check.
     */
    function setAllocations(
        bytes32 seasonId,
        address[] calldata players,
        uint256[] calldata amounts
    ) external onlyOperator {
        Season storage s = _seasons[seasonId];
        if (s.state != SeasonState.Open) revert SeasonNotOpen();
        if (players.length != amounts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            if (player == address(0)) revert ZeroAddress();

            uint256 previous = _allocation[seasonId][player];
            uint256 next = amounts[i];
            _allocation[seasonId][player] = next;

            // Delta-adjust so an overwrite cannot inflate the running total.
            s.allocated = s.allocated + next - previous;

            emit AllocationSet(seasonId, player, next);
        }
    }

    /**
     * @notice Freeze allocations and open claiming.
     * @dev Reverts unless the escrow can actually cover every allocation — see
     *      the contract docstring for why a partial pool is worse than none.
     */
    function finalize(bytes32 seasonId) external onlyOperator {
        Season storage s = _seasons[seasonId];
        if (s.state != SeasonState.Open) revert SeasonNotOpen();
        if (s.allocated == 0) revert NothingAllocated();
        if (s.allocated > s.funded) {
            revert AllocationsExceedFunding(s.allocated, s.funded);
        }

        s.state = SeasonState.Finalized;
        s.finalizedAtSec = uint64(block.timestamp);
        emit SeasonFinalized(seasonId, s.allocated, s.funded);
    }

    /**
     * @notice Claim your allocation. Callable once, by the winner.
     * @dev The claimed flag is set BEFORE the transfer (checks-effects-
     *      interactions) and the function is `nonReentrant`, so a token with a
     *      transfer hook cannot re-enter to claim twice.
     */
    function claim(bytes32 seasonId) external nonReentrant {
        Season storage s = _seasons[seasonId];
        if (s.state != SeasonState.Finalized) revert SeasonNotFinalized();
        if (_claimed[seasonId][msg.sender]) revert AlreadyClaimed();

        uint256 amount = _allocation[seasonId][msg.sender];
        if (amount == 0) revert NothingAllocated();

        _claimed[seasonId][msg.sender] = true;
        s.claimed += amount;

        IERC20(s.token).safeTransfer(msg.sender, amount);
        emit PrizeClaimed(seasonId, msg.sender, amount);
    }

    /**
     * @notice Withdraw the surplus above what winners are still owed.
     * @dev Bounded by `funded - allocated`, so an unclaimed prize can never be
     *      swept. Finalization is required first, because before then
     *      `allocated` is not yet the final obligation.
     */
    function withdrawSurplus(bytes32 seasonId, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        Season storage s = _seasons[seasonId];
        if (s.state != SeasonState.Finalized) revert SeasonNotFinalized();
        if (to == address(0)) revert ZeroAddress();

        uint256 surplus = s.funded - s.allocated;
        if (amount == 0 || amount > surplus) revert InsufficientSurplus();

        // Reduce recorded funding so the surplus cannot be withdrawn twice.
        s.funded -= amount;

        IERC20(s.token).safeTransfer(to, amount);
        emit SurplusWithdrawn(seasonId, to, amount);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function getSeason(bytes32 seasonId) external view returns (Season memory) {
        return _seasons[seasonId];
    }

    function allocationOf(bytes32 seasonId, address player)
        external
        view
        returns (uint256)
    {
        return _allocation[seasonId][player];
    }

    function hasClaimed(bytes32 seasonId, address player) external view returns (bool) {
        return _claimed[seasonId][player];
    }

    /**
     * @notice What `player` can claim right now.
     * @dev Returns 0 both before finalization and after claiming, so a UI can
     *      render a single "claimable" number without duplicating the state
     *      machine client-side.
     */
    function claimable(bytes32 seasonId, address player) external view returns (uint256) {
        if (_seasons[seasonId].state != SeasonState.Finalized) return 0;
        if (_claimed[seasonId][player]) return 0;
        return _allocation[seasonId][player];
    }

    /// @notice Collateral still owed to unclaimed winners.
    function outstanding(bytes32 seasonId) external view returns (uint256) {
        Season storage s = _seasons[seasonId];
        return s.allocated - s.claimed;
    }
}
