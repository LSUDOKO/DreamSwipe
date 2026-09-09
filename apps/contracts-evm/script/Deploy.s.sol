// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DreamSwipeDuel} from "../src/DreamSwipeDuel.sol";

/**
 * @title Deploy
 * @notice Deploys `DreamSwipeDuel` and prints the artifact fields
 *         `specs/09_DEPLOYMENT_OPERATIONS.md` requires in
 *         `deployments/<network>.json`.
 *
 * @dev Usage:
 *
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url somnia_testnet --broadcast
 *
 * Required env:
 *   PRIVATE_KEY  deployer key (never committed)
 *   KEEPER       keeper address; defaults to the deployer if unset
 *
 * ── Somnia gas ──────────────────────────────────────────────────────────────
 *
 * Somnia prices state creation far more aggressively than Ethereum and enforces
 * a ~6 gwei minimum base fee. Gas is therefore ESTIMATED by the broadcast
 * rather than pinned to Ethereum-shaped constants — a hardcoded limit here can
 * mine with status 0 and burn the whole allowance.
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Default the keeper to the deployer so a first deploy works without
        // extra setup; rotate it afterwards with `setKeeper`.
        address keeper = vm.envOr("KEEPER", deployer);

        vm.startBroadcast(deployerKey);
        DreamSwipeDuel duel = new DreamSwipeDuel(keeper);
        vm.stopBroadcast();

        console.log("=== DreamSwipeDuel deployed ===");
        console.log("chainId       ", block.chainid);
        console.log("address       ", address(duel));
        console.log("deployer      ", deployer);
        console.log("keeper        ", keeper);
        console.log("blockNumber   ", block.number);
        console.log("timestamp     ", block.timestamp);
    }
}
