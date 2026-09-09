// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SeasonPrizePool} from "../src/SeasonPrizePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @title SeasonPrizePool tests
 * @notice Covers the lifecycle plus the properties that actually protect a
 *         winner's prize: one claim each, allocations frozen at finalization,
 *         a pool that cannot promise more than it holds, and a surplus
 *         withdrawal that can never touch money someone is still owed.
 */
contract SeasonPrizePoolTest is Test {
    SeasonPrizePool internal pool;
    MockERC20 internal usdc;

    address internal owner = address(this);
    address internal operator;
    address internal alice;
    address internal bob;
    address internal mallory;
    address internal sponsor;

    bytes32 internal constant SEASON = keccak256("season-1");
    uint256 internal constant ONE = 1_000_000; // 6-decimal collateral

    function setUp() public {
        operator = makeAddr("operator");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        mallory = makeAddr("mallory");
        sponsor = makeAddr("sponsor");

        usdc = new MockERC20("Test USDC", "tUSDC", 6);
        pool = new SeasonPrizePool(operator);

        usdc.mint(sponsor, 1000 * ONE);
        vm.prank(sponsor);
        usdc.approve(address(pool), type(uint256).max);

        pool.createSeason(SEASON, address(usdc));
    }

    function _fund(uint256 amount) internal {
        vm.prank(sponsor);
        pool.fund(SEASON, amount);
    }

    function _allocate(address player, uint256 amount) internal {
        address[] memory players = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        players[0] = player;
        amounts[0] = amount;
        vm.prank(operator);
        pool.setAllocations(SEASON, players, amounts);
    }

    // ─── Creation and funding ───────────────────────────────────────────────

    function test_createSeason_opensIt() public view {
        SeasonPrizePool.Season memory s = pool.getSeason(SEASON);
        assertEq(uint8(s.state), uint8(SeasonPrizePool.SeasonState.Open));
        assertEq(s.token, address(usdc));
    }

    function test_createSeason_onlyOwner() public {
        vm.prank(mallory);
        vm.expectRevert(SeasonPrizePool.NotOwner.selector);
        pool.createSeason(keccak256("season-2"), address(usdc));
    }

    function test_createSeason_cannotReuseAnId() public {
        vm.expectRevert(SeasonPrizePool.SeasonExists.selector);
        pool.createSeason(SEASON, address(usdc));
    }

    function test_fund_isPermissionless() public {
        // A sponsor topping up a prize pool needs no privileges.
        _fund(100 * ONE);
        assertEq(pool.getSeason(SEASON).funded, 100 * ONE);
        assertEq(usdc.balanceOf(address(pool)), 100 * ONE);
    }

    function test_fund_accumulates() public {
        _fund(60 * ONE);
        _fund(40 * ONE);
        assertEq(pool.getSeason(SEASON).funded, 100 * ONE);
    }

    function test_fund_rejectsZero() public {
        vm.prank(sponsor);
        vm.expectRevert(SeasonPrizePool.ZeroAmount.selector);
        pool.fund(SEASON, 0);
    }

    function test_fund_rejectsUnknownSeason() public {
        vm.prank(sponsor);
        vm.expectRevert(SeasonPrizePool.SeasonNotOpen.selector);
        pool.fund(keccak256("nope"), ONE);
    }

    // ─── Allocation ─────────────────────────────────────────────────────────

    function test_setAllocations_recordsEach() public {
        address[] memory players = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        players[0] = alice;
        players[1] = bob;
        amounts[0] = 60 * ONE;
        amounts[1] = 40 * ONE;

        vm.prank(operator);
        pool.setAllocations(SEASON, players, amounts);

        assertEq(pool.allocationOf(SEASON, alice), 60 * ONE);
        assertEq(pool.allocationOf(SEASON, bob), 40 * ONE);
        assertEq(pool.getSeason(SEASON).allocated, 100 * ONE);
    }

    function test_setAllocations_overwriteDoesNotDoubleCount() public {
        // A leaderboard can be recomputed before finalization; the running
        // total must track the delta or the funding check is meaningless.
        _allocate(alice, 100 * ONE);
        _allocate(alice, 30 * ONE);
        assertEq(pool.getSeason(SEASON).allocated, 30 * ONE);
    }

    function test_setAllocations_onlyOperator() public {
        address[] memory players = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        players[0] = alice;
        amounts[0] = ONE;

        vm.prank(mallory);
        vm.expectRevert(SeasonPrizePool.NotOperator.selector);
        pool.setAllocations(SEASON, players, amounts);

        // Even the owner cannot allocate — the roles are deliberately split.
        vm.expectRevert(SeasonPrizePool.NotOperator.selector);
        pool.setAllocations(SEASON, players, amounts);
    }

    function test_setAllocations_rejectsMismatchedArrays() public {
        address[] memory players = new address[](2);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(operator);
        vm.expectRevert(SeasonPrizePool.ArrayLengthMismatch.selector);
        pool.setAllocations(SEASON, players, amounts);
    }

    // ─── Finalization ───────────────────────────────────────────────────────

    function test_finalize_freezesAllocations() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);

        vm.prank(operator);
        pool.finalize(SEASON);

        SeasonPrizePool.Season memory s = pool.getSeason(SEASON);
        assertEq(uint8(s.state), uint8(SeasonPrizePool.SeasonState.Finalized));

        // The property that makes escrow meaningful: after finalization the
        // operator cannot rewrite who gets what.
        address[] memory players = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        players[0] = mallory;
        amounts[0] = 40 * ONE;
        vm.prank(operator);
        vm.expectRevert(SeasonPrizePool.SeasonNotOpen.selector);
        pool.setAllocations(SEASON, players, amounts);
    }

    function test_finalize_refusesToPromiseMoreThanItHolds() public {
        // Otherwise early claimants drain the pool and later ones revert on an
        // empty balance — a failure that looks like the claimer's own bug.
        _fund(50 * ONE);
        _allocate(alice, 80 * ONE);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SeasonPrizePool.AllocationsExceedFunding.selector,
                80 * ONE,
                50 * ONE
            )
        );
        pool.finalize(SEASON);
    }

    function test_finalize_refusesAnEmptyAllocation() public {
        _fund(100 * ONE);
        vm.prank(operator);
        vm.expectRevert(SeasonPrizePool.NothingAllocated.selector);
        pool.finalize(SEASON);
    }

    function test_finalize_onlyOperator() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(mallory);
        vm.expectRevert(SeasonPrizePool.NotOperator.selector);
        pool.finalize(SEASON);
    }

    function test_finalize_cannotRunTwice() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.startPrank(operator);
        pool.finalize(SEASON);
        vm.expectRevert(SeasonPrizePool.SeasonNotOpen.selector);
        pool.finalize(SEASON);
        vm.stopPrank();
    }

    // ─── Claiming ───────────────────────────────────────────────────────────

    function _finalizedSeason() internal {
        _fund(100 * ONE);
        address[] memory players = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        players[0] = alice;
        players[1] = bob;
        amounts[0] = 60 * ONE;
        amounts[1] = 40 * ONE;
        vm.startPrank(operator);
        pool.setAllocations(SEASON, players, amounts);
        pool.finalize(SEASON);
        vm.stopPrank();
    }

    function test_claim_paysTheAllocation() public {
        _finalizedSeason();
        vm.prank(alice);
        pool.claim(SEASON);

        assertEq(usdc.balanceOf(alice), 60 * ONE);
        assertTrue(pool.hasClaimed(SEASON, alice));
        assertEq(pool.getSeason(SEASON).claimed, 60 * ONE);
    }

    function test_claim_isOncePerPlayer() public {
        // The core "claimed protection" the spec asks for.
        _finalizedSeason();
        vm.startPrank(alice);
        pool.claim(SEASON);
        vm.expectRevert(SeasonPrizePool.AlreadyClaimed.selector);
        pool.claim(SEASON);
        vm.stopPrank();
    }

    function test_claim_rejectsSomeoneWithNoAllocation() public {
        _finalizedSeason();
        vm.prank(mallory);
        vm.expectRevert(SeasonPrizePool.NothingAllocated.selector);
        pool.claim(SEASON);
    }

    function test_claim_blockedBeforeFinalization() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(alice);
        vm.expectRevert(SeasonPrizePool.SeasonNotFinalized.selector);
        pool.claim(SEASON);
    }

    function test_claim_everyWinnerIsPaidInFull() public {
        _finalizedSeason();
        vm.prank(alice);
        pool.claim(SEASON);
        vm.prank(bob);
        pool.claim(SEASON);

        assertEq(usdc.balanceOf(alice), 60 * ONE);
        assertEq(usdc.balanceOf(bob), 40 * ONE);
        // Every allocated unit left the pool; nothing is stranded.
        assertEq(pool.outstanding(SEASON), 0);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_claimable_viewTracksState() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);

        // 0 before finalization, even though an allocation exists — the UI
        // should not offer a claim that would revert.
        assertEq(pool.claimable(SEASON, alice), 0);

        vm.prank(operator);
        pool.finalize(SEASON);
        assertEq(pool.claimable(SEASON, alice), 60 * ONE);

        vm.prank(alice);
        pool.claim(SEASON);
        assertEq(pool.claimable(SEASON, alice), 0);
    }

    // ─── Surplus ────────────────────────────────────────────────────────────

    function test_withdrawSurplus_takesOnlyTheUnallocatedRemainder() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(operator);
        pool.finalize(SEASON);

        pool.withdrawSurplus(SEASON, owner, 40 * ONE);
        assertEq(usdc.balanceOf(owner), 40 * ONE);

        // Alice's prize survives the sweep.
        vm.prank(alice);
        pool.claim(SEASON);
        assertEq(usdc.balanceOf(alice), 60 * ONE);
    }

    function test_withdrawSurplus_cannotTouchAnUnclaimedPrize() public {
        // The invariant that matters most here: a winner who claims late must
        // still be paid.
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(operator);
        pool.finalize(SEASON);

        vm.expectRevert(SeasonPrizePool.InsufficientSurplus.selector);
        pool.withdrawSurplus(SEASON, owner, 41 * ONE);
    }

    function test_withdrawSurplus_cannotBeTakenTwice() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(operator);
        pool.finalize(SEASON);

        pool.withdrawSurplus(SEASON, owner, 40 * ONE);
        vm.expectRevert(SeasonPrizePool.InsufficientSurplus.selector);
        pool.withdrawSurplus(SEASON, owner, 1);
    }

    function test_withdrawSurplus_blockedBeforeFinalization() public {
        // Before finalization `allocated` is not the final obligation, so a
        // "surplus" is not yet knowable.
        _fund(100 * ONE);
        vm.expectRevert(SeasonPrizePool.SeasonNotFinalized.selector);
        pool.withdrawSurplus(SEASON, owner, ONE);
    }

    function test_withdrawSurplus_onlyOwner() public {
        _fund(100 * ONE);
        _allocate(alice, 60 * ONE);
        vm.prank(operator);
        pool.finalize(SEASON);

        // The operator sets allocations but must not be able to move funds out.
        vm.prank(operator);
        vm.expectRevert(SeasonPrizePool.NotOwner.selector);
        pool.withdrawSurplus(SEASON, operator, ONE);
    }

    // ─── Roles ──────────────────────────────────────────────────────────────

    function test_setOperator_rotates() public {
        address next = makeAddr("operator2");
        pool.setOperator(next);
        assertEq(pool.operator(), next);
    }

    function test_setOperator_onlyOwner() public {
        vm.prank(mallory);
        vm.expectRevert(SeasonPrizePool.NotOwner.selector);
        pool.setOperator(mallory);
    }

    // ─── Solvency (property-style) ──────────────────────────────────────────

    /**
     * @dev Whatever the split, a finalized pool can always pay every winner in
     *      full. This is the property that makes the funding check at
     *      `finalize` load-bearing rather than decorative.
     */
    function testFuzz_finalizedPoolIsAlwaysSolvent(
        uint96 aliceCut,
        uint96 bobCut
    ) public {
        uint256 a = bound(uint256(aliceCut), 1, 500 * ONE);
        uint256 b = bound(uint256(bobCut), 1, 500 * ONE);

        _fund(a + b);
        address[] memory players = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        players[0] = alice;
        players[1] = bob;
        amounts[0] = a;
        amounts[1] = b;

        vm.startPrank(operator);
        pool.setAllocations(SEASON, players, amounts);
        pool.finalize(SEASON);
        vm.stopPrank();

        vm.prank(alice);
        pool.claim(SEASON);
        vm.prank(bob);
        pool.claim(SEASON);

        assertEq(usdc.balanceOf(alice), a);
        assertEq(usdc.balanceOf(bob), b);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }
}
