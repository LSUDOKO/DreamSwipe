// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DreamSwipeDuel} from "../src/DreamSwipeDuel.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @title DreamSwipeDuel tests
 * @notice Covers the lifecycle and, more importantly, every security invariant
 *         `specs/03_SMART_CONTRACTS.md` and `specs/08_SECURITY_TESTING.md` call
 *         out: replay, unauthorized settlement, double settlement, double
 *         payout, timeouts/refunds, draws, and escrow conservation.
 *
 * @dev The escrow-conservation checks are the ones that matter most. Every
 *      terminal path asserts the contract's own balance returns to zero and
 *      that exactly the deposited collateral was paid out — no more (which
 *      would be a drain) and no less (which would be trapped funds).
 */
contract DreamSwipeDuelTest is Test {
    DreamSwipeDuel internal duel;
    MockERC20 internal usdc;

    // Signing keys — the player addresses are DERIVED from these so EIP-712
    // signatures actually verify.
    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;
    uint256 internal constant MALLORY_PK = 0xBAD;

    address internal alice;
    address internal bob;
    address internal mallory;
    address internal keeper;
    address internal admin = address(this);

    /// 6-decimal collateral, matching Shannon testnet tUSDC.
    uint128 internal constant ONE = 1_000_000;
    uint128 internal constant STAKE = 5 * ONE;

    bytes32 internal constant SALT = keccak256("salt");

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        mallory = vm.addr(MALLORY_PK);
        keeper = makeAddr("keeper");

        usdc = new MockERC20("Test USDC", "tUSDC", 6);
        duel = new DreamSwipeDuel(keeper);

        usdc.mint(alice, 1000 * ONE);
        usdc.mint(bob, 1000 * ONE);

        vm.prank(alice);
        usdc.approve(address(duel), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(duel), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _deck3() internal pure returns (bytes32[] memory ids, uint256[] memory strikes) {
        ids = new bytes32[](3);
        strikes = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            ids[i] = keccak256(abi.encodePacked("market", i));
            strikes[i] = 0;
        }
    }

    function _commit(bytes32[] memory ids, uint256[] memory strikes) internal pure returns (bytes32) {
        return keccak256(abi.encode(ids, strikes, SALT));
    }

    function _createStaked() internal returns (bytes32 duelId) {
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(alice);
        duelId = duel.createDuel(
            _commit(ids, strikes), 3, DreamSwipeDuel.Tier.Staked, address(usdc), STAKE
        );
    }

    function _startedDuel() internal returns (bytes32 duelId) {
        duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(keeper);
        duel.revealDeck(duelId, ids, strikes, SALT);
    }

    /// @dev Produce a valid EIP-712 swipe signature for `pk`.
    function _sign(
        uint256 pk,
        bytes32 duelId,
        uint8 cardIdx,
        DreamSwipeDuel.Direction dir,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = duel.swipeDigest(duelId, cardIdx, dir, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _swipe(
        uint256 pk,
        address player,
        bytes32 duelId,
        uint8 cardIdx,
        DreamSwipeDuel.Direction dir,
        uint128 premium,
        uint128 filled
    ) internal {
        uint256 nonce = duel.nonces(player);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(pk, duelId, cardIdx, dir, nonce, deadline);
        vm.prank(keeper);
        duel.recordSwipe(duelId, player, cardIdx, dir, premium, filled, nonce, deadline, sig);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    function test_createDuel_escrowsStakeAndSetsPending() public {
        bytes32 duelId = _createStaked();
        DreamSwipeDuel.Duel memory d = duel.getDuel(duelId);

        assertEq(uint8(d.status), uint8(DreamSwipeDuel.Status.Pending));
        assertEq(d.creator, alice);
        assertEq(d.stake, STAKE);
        assertEq(usdc.balanceOf(address(duel)), STAKE);
    }

    function test_createDuel_rejectsDeckSizeOutOfBounds() public {
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        bytes32 c = _commit(ids, strikes);

        vm.prank(alice);
        vm.expectRevert(DreamSwipeDuel.InvalidDeckSize.selector);
        duel.createDuel(c, 2, DreamSwipeDuel.Tier.Staked, address(usdc), STAKE);

        vm.prank(alice);
        vm.expectRevert(DreamSwipeDuel.InvalidDeckSize.selector);
        duel.createDuel(c, 6, DreamSwipeDuel.Tier.Staked, address(usdc), STAKE);
    }

    function test_createDuel_freeTierCannotCarryStake() public {
        // Guards the "gate the money flow, keep the engine" invariant: a Free
        // duel that moved collateral would be a silent tier violation.
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(alice);
        vm.expectRevert(DreamSwipeDuel.StakeMustBeZeroForFreeTier.selector);
        duel.createDuel(_commit(ids, strikes), 3, DreamSwipeDuel.Tier.Free, address(usdc), STAKE);
    }

    function test_joinDuel_activatesAndEscrowsBothStakes() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        DreamSwipeDuel.Duel memory d = duel.getDuel(duelId);
        assertEq(uint8(d.status), uint8(DreamSwipeDuel.Status.Active));
        assertEq(d.challenger, bob);
        assertEq(usdc.balanceOf(address(duel)), STAKE * 2);
    }

    function test_joinDuel_creatorCannotJoinOwnDuel() public {
        bytes32 duelId = _createStaked();
        vm.prank(alice);
        vm.expectRevert(DreamSwipeDuel.CreatorCannotJoin.selector);
        duel.joinDuel(duelId);
    }

    function test_joinDuel_cannotDoubleJoin() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        usdc.mint(mallory, 100 * ONE);
        vm.prank(mallory);
        usdc.approve(address(duel), type(uint256).max);
        vm.prank(mallory);
        vm.expectRevert(DreamSwipeDuel.DuelNotPending.selector);
        duel.joinDuel(duelId);
    }

    // ─── Commit-reveal ──────────────────────────────────────────────────────

    function test_revealDeck_acceptsTheCommittedDeck() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(keeper);
        duel.revealDeck(duelId, ids, strikes, SALT);

        assertEq(duel.getDeck(duelId).length, 3);
        assertTrue(duel.getDuel(duelId).deckRevealed);
    }

    function test_revealDeck_rejectsASubstitutedDeck() public {
        // The core fairness property: having seen the matchup, the server must
        // not be able to swap in a different deck than the one committed.
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        ids[1] = keccak256("a different market"); // tamper

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.DeckCommitMismatch.selector);
        duel.revealDeck(duelId, ids, strikes, SALT);
    }

    function test_revealDeck_rejectsWrongSalt() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.DeckCommitMismatch.selector);
        duel.revealDeck(duelId, ids, strikes, keccak256("wrong"));
    }

    function test_revealDeck_onlyKeeper() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(mallory);
        vm.expectRevert(DreamSwipeDuel.NotKeeper.selector);
        duel.revealDeck(duelId, ids, strikes, SALT);
    }

    function test_revealDeck_cannotRevealTwice() public {
        bytes32 duelId = _startedDuel();
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.DeckAlreadyRevealed.selector);
        duel.revealDeck(duelId, ids, strikes, SALT);
    }

    // ─── Swipes: signature, replay, authorization ───────────────────────────

    function test_recordSwipe_storesAValidlySignedSwipe() public {
        bytes32 duelId = _startedDuel();
        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);

        DreamSwipeDuel.Swipe memory s = duel.getSwipe(duelId, alice, 0);
        assertTrue(s.exists);
        assertEq(uint8(s.direction), uint8(DreamSwipeDuel.Direction.Up));
        assertEq(s.premium, 400_000);
        assertEq(duel.nonces(alice), 1);
    }

    function test_recordSwipe_rejectsSignatureFromSomeoneElse() public {
        // Mallory signing on Alice's behalf must not be accepted, even though
        // the keeper is the one submitting.
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(MALLORY_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.InvalidSignature.selector);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsFlippedDirection() public {
        // A relayer must not be able to take a signature for Up and submit it
        // as Down — direction is inside the signed struct.
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ALICE_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.InvalidSignature.selector);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Down, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsReplayOfTheSameSignature() public {
        // Nonce consumption is what stops a captured signature being replayed.
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ALICE_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.AlreadySwiped.selector);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsReusedNonceOnAnotherCard() public {
        // Even against a different card, a stale nonce must not be accepted.
        bytes32 duelId = _startedDuel();
        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ALICE_PK, duelId, 1, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.InvalidNonce.selector);
        duel.recordSwipe(
            duelId, alice, 1, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsExpiredSignature() public {
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 10;
        bytes memory sig = _sign(ALICE_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.warp(deadline + 1);
        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.SignatureExpired.selector);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsNonPlayer() public {
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(MALLORY_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.NotPlayer.selector);
        duel.recordSwipe(
            duelId, mallory, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_rejectsCardOutOfBounds() public {
        bytes32 duelId = _startedDuel();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ALICE_PK, duelId, 9, DreamSwipeDuel.Direction.Up, 0, deadline);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.CardIndexOutOfBounds.selector);
        duel.recordSwipe(
            duelId, alice, 9, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    function test_recordSwipe_requiresRevealedDeck() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ALICE_PK, duelId, 0, DreamSwipeDuel.Direction.Up, 0, deadline);
        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.DeckNotRevealed.selector);
        duel.recordSwipe(
            duelId, alice, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE, 0, deadline, sig
        );
    }

    // ─── Settlement ─────────────────────────────────────────────────────────

    function test_settleCard_scoresRealizedPnl() public {
        bytes32 duelId = _startedDuel();
        // Alice backs Up at 0.40 for 1 contract; Bob backs Down at 0.60.
        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);
        _swipe(BOB_PK, bob, duelId, 0, DreamSwipeDuel.Direction.Down, 600_000, ONE);

        vm.prank(keeper);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, false);

        DreamSwipeDuel.Duel memory d = duel.getDuel(duelId);
        // Alice: redeem 1.00 - paid 0.40 = +0.60. Bob: 0 - 0.60 = -0.60.
        assertEq(d.p0Score, int256(600_000));
        assertEq(d.p1Score, -int256(600_000));
    }

    function test_settleCard_voidedRefundsBothAtHalf() public {
        bytes32 duelId = _startedDuel();
        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);
        _swipe(BOB_PK, bob, duelId, 0, DreamSwipeDuel.Direction.Down, 400_000, ONE);

        vm.prank(keeper);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, true);

        DreamSwipeDuel.Duel memory d = duel.getDuel(duelId);
        // Both get 0.50 back against 0.40 paid, regardless of side taken.
        assertEq(d.p0Score, int256(100_000));
        assertEq(d.p1Score, int256(100_000));
    }

    function test_settleCard_missingSwipeScoresZeroNotALoss() public {
        // A player who never got to swipe must not be punished for it.
        bytes32 duelId = _startedDuel();
        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);

        vm.prank(keeper);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Down, false);

        DreamSwipeDuel.Duel memory d = duel.getDuel(duelId);
        assertEq(d.p0Score, -int256(400_000));
        assertEq(d.p1Score, 0);
    }

    function test_settleCard_cannotSettleTwice() public {
        // Double settlement would inflate scores from one real market outcome.
        bytes32 duelId = _startedDuel();
        vm.prank(keeper);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, false);

        vm.prank(keeper);
        vm.expectRevert(DreamSwipeDuel.CardAlreadySettled.selector);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, false);
    }

    function test_settleCard_onlyKeeper() public {
        bytes32 duelId = _startedDuel();
        vm.prank(mallory);
        vm.expectRevert(DreamSwipeDuel.NotKeeper.selector);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, false);
    }

    // ─── Finalization and payout ────────────────────────────────────────────

    function _settleAll(bytes32 duelId, DreamSwipeDuel.Direction winner) internal {
        for (uint8 i = 0; i < 3; i++) {
            vm.prank(keeper);
            duel.settleCard(duelId, i, winner, false);
        }
    }

    function test_finalize_paysTheWholePotToTheWinner() public {
        bytes32 duelId = _startedDuel();
        uint256 aliceBefore = usdc.balanceOf(alice);

        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);
        _swipe(BOB_PK, bob, duelId, 0, DreamSwipeDuel.Direction.Down, 600_000, ONE);
        _settleAll(duelId, DreamSwipeDuel.Direction.Up);

        duel.finalize(duelId);

        assertEq(usdc.balanceOf(alice), aliceBefore + STAKE * 2);
        // Escrow conservation: nothing left behind.
        assertEq(usdc.balanceOf(address(duel)), 0);
    }

    function test_finalize_drawReturnsEachStake() public {
        // Neither player swiped, so both score 0 — an exact tie must refund
        // rather than arbitrarily award the pot.
        bytes32 duelId = _startedDuel();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        _settleAll(duelId, DreamSwipeDuel.Direction.Up);
        duel.finalize(duelId);

        assertEq(usdc.balanceOf(alice), aliceBefore + STAKE);
        assertEq(usdc.balanceOf(bob), bobBefore + STAKE);
        assertEq(usdc.balanceOf(address(duel)), 0);
    }

    function test_finalize_requiresEveryCardSettled() public {
        bytes32 duelId = _startedDuel();
        vm.prank(keeper);
        duel.settleCard(duelId, 0, DreamSwipeDuel.Direction.Up, false);

        vm.expectRevert(DreamSwipeDuel.CardsNotAllSettled.selector);
        duel.finalize(duelId);
    }

    function test_finalize_cannotPayOutTwice() public {
        // The invariant that stops the pot being drained by repeated calls.
        bytes32 duelId = _startedDuel();
        _settleAll(duelId, DreamSwipeDuel.Direction.Up);
        duel.finalize(duelId);

        vm.expectRevert(DreamSwipeDuel.DuelNotActive.selector);
        duel.finalize(duelId);
    }

    function test_finalize_freeTierMovesNoMoney() public {
        (bytes32[] memory ids, uint256[] memory strikes) = _deck3();
        vm.prank(alice);
        bytes32 duelId =
            duel.createDuel(_commit(ids, strikes), 3, DreamSwipeDuel.Tier.Free, address(0), 0);
        vm.prank(bob);
        duel.joinDuel(duelId);
        vm.prank(keeper);
        duel.revealDeck(duelId, ids, strikes, SALT);

        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, 400_000, ONE);
        _settleAll(duelId, DreamSwipeDuel.Direction.Up);
        duel.finalize(duelId);

        // Same engine, same scoring — just no collateral in play.
        assertEq(usdc.balanceOf(address(duel)), 0);
        assertEq(uint8(duel.getDuel(duelId).status), uint8(DreamSwipeDuel.Status.Complete));
    }

    // ─── Refunds and timeouts ───────────────────────────────────────────────

    function test_cancelPending_returnsCreatorStake() public {
        bytes32 duelId = _createStaked();
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        duel.cancelPending(duelId);

        assertEq(usdc.balanceOf(alice), before + STAKE);
        assertEq(usdc.balanceOf(address(duel)), 0);
    }

    function test_cancelPending_onlyCreator() public {
        bytes32 duelId = _createStaked();
        vm.prank(mallory);
        vm.expectRevert(DreamSwipeDuel.NotPlayer.selector);
        duel.cancelPending(duelId);
    }

    function test_claimRevealTimeout_refundsBothWhenKeeperStalls() public {
        // Without this, a creator who dislikes the deck could strand the
        // challenger's collateral forever by simply never revealing.
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.warp(block.timestamp + duel.REVEAL_TIMEOUT_SEC() + 1);
        // Permissionless: the challenger must not need anyone's cooperation.
        vm.prank(mallory);
        duel.claimRevealTimeout(duelId);

        assertEq(usdc.balanceOf(alice), aliceBefore + STAKE);
        assertEq(usdc.balanceOf(bob), bobBefore + STAKE);
        assertEq(usdc.balanceOf(address(duel)), 0);
    }

    function test_claimRevealTimeout_notBeforeTheDeadline() public {
        bytes32 duelId = _createStaked();
        vm.prank(bob);
        duel.joinDuel(duelId);

        vm.expectRevert(DreamSwipeDuel.TimeoutNotReached.selector);
        duel.claimRevealTimeout(duelId);
    }

    function test_claimRevealTimeout_blockedOnceRevealed() public {
        bytes32 duelId = _startedDuel();
        vm.warp(block.timestamp + duel.REVEAL_TIMEOUT_SEC() + 1);
        vm.expectRevert(DreamSwipeDuel.DeckAlreadyRevealed.selector);
        duel.claimRevealTimeout(duelId);
    }

    function test_claimDuelTimeout_rescuesEscrowFromAStalledDuel() public {
        // The backstop for a venue outage — escrow must never be trapped by a
        // third party's failure.
        bytes32 duelId = _startedDuel();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.warp(block.timestamp + duel.DUEL_TIMEOUT_SEC() + 1);
        duel.claimDuelTimeout(duelId);

        assertEq(usdc.balanceOf(alice), aliceBefore + STAKE);
        assertEq(usdc.balanceOf(bob), bobBefore + STAKE);
        assertEq(usdc.balanceOf(address(duel)), 0);
    }

    function test_claimDuelTimeout_notBeforeTheDeadline() public {
        bytes32 duelId = _startedDuel();
        vm.expectRevert(DreamSwipeDuel.TimeoutNotReached.selector);
        duel.claimDuelTimeout(duelId);
    }

    function test_timeoutCannotBeClaimedTwice() public {
        bytes32 duelId = _startedDuel();
        vm.warp(block.timestamp + duel.DUEL_TIMEOUT_SEC() + 1);
        duel.claimDuelTimeout(duelId);

        vm.expectRevert(DreamSwipeDuel.DuelNotActive.selector);
        duel.claimDuelTimeout(duelId);
    }

    // ─── Access control ─────────────────────────────────────────────────────

    function test_setKeeper_onlyAdmin() public {
        vm.prank(mallory);
        vm.expectRevert(DreamSwipeDuel.NotAdmin.selector);
        duel.setKeeper(mallory);
    }

    function test_setKeeper_rotates() public {
        address newKeeper = makeAddr("newKeeper");
        duel.setKeeper(newKeeper);
        assertEq(duel.keeper(), newKeeper);
    }

    // ─── Escrow conservation (property-style) ───────────────────────────────

    /**
     * @dev The invariant `specs/03_SMART_CONTRACTS.md` asks for: whatever the
     *      scores, a finalized duel pays out EXACTLY the collateral deposited —
     *      never more (a drain) and never less (trapped funds).
     */
    function testFuzz_escrowIsConserved(uint128 p0Premium, uint128 p1Premium, bool upWins)
        public
    {
        p0Premium = uint128(bound(p0Premium, 0, ONE));
        p1Premium = uint128(bound(p1Premium, 0, ONE));

        bytes32 duelId = _startedDuel();
        uint256 totalBefore = usdc.balanceOf(alice) + usdc.balanceOf(bob);
        assertEq(usdc.balanceOf(address(duel)), STAKE * 2);

        _swipe(ALICE_PK, alice, duelId, 0, DreamSwipeDuel.Direction.Up, p0Premium, ONE);
        _swipe(BOB_PK, bob, duelId, 0, DreamSwipeDuel.Direction.Down, p1Premium, ONE);
        _settleAll(
            duelId, upWins ? DreamSwipeDuel.Direction.Up : DreamSwipeDuel.Direction.Down
        );
        duel.finalize(duelId);

        // All escrow returned to the players, and none retained.
        assertEq(usdc.balanceOf(address(duel)), 0);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob), totalBefore + STAKE * 2);
    }
}
