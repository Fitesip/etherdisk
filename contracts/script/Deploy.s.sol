// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Etherdisk} from "../src/Etherdisk.sol";

/// Tiers come from the environment (comma-separated, same length), the testnet set by default:
///   TIER_CAPACITIES_GB=64,128,256,512,1024,2048
///   TIER_PRICES_WEI=...
///   TIER_ACTIVE=true,true,true,false,false,false     (false: listed as "coming soon")
///   OWNER=0x...                                      (default: the deployer; use the Safe on mainnet)
contract Deploy is Script {
    function run() external {
        uint256[] memory defCaps = new uint256[](3);
        uint256[] memory defPrices = new uint256[](3);
        bool[] memory defActive = new bool[](3);
        (defCaps[0], defCaps[1], defCaps[2]) = (1, 2, 4);
        (defPrices[0], defPrices[1], defPrices[2]) = (0.0005 ether, 0.00075 ether, 0.001 ether);
        (defActive[0], defActive[1], defActive[2]) = (true, true, true);

        uint256[] memory caps = vm.envOr("TIER_CAPACITIES_GB", ",", defCaps);
        uint256[] memory prices = vm.envOr("TIER_PRICES_WEI", ",", defPrices);
        bool[] memory active = vm.envOr("TIER_ACTIVE", ",", defActive);
        uint32[] memory caps32 = new uint32[](caps.length);
        for (uint256 i; i < caps.length; i++) {
            caps32[i] = uint32(caps[i]);
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);
        Etherdisk disk = new Etherdisk(owner, caps32, prices, active);
        vm.stopBroadcast();
        console.log("Owner:", owner);
        console.log("Etherdisk deployed at:", address(disk));
    }
}
