// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskRenderer} from "../src/EtherdiskRenderer.sol";

/// Deploys the renderer, then Etherdisk. Settings come from the environment (comma-separated
/// lists of the same length), the testnet set by default:
///   TIER_CAPACITIES_GB=64,128,256,512,1024,2048
///   TIER_PRICES_WEI=...
///   TIER_ACTIVE=true,true,true,false,false,false     (false: listed as "coming soon")
///   TIER_COLORS=0x6366f1,0x10b981,...                (0xrrggbb)
///   ROYALTY_BPS=500                                  (5% on resales, to the owner)
///   PAGE_BASE=https://etherdisk.app/nft/             (the drive's page: this + token id)
///   OWNER=0x...                                      (default: the deployer; use the Safe on mainnet)
contract Deploy is Script {
    function run() external {
        uint256[] memory defCaps = new uint256[](3);
        uint256[] memory defPrices = new uint256[](3);
        bool[] memory defActive = new bool[](3);
        uint256[] memory defColors = new uint256[](3);
        (defCaps[0], defCaps[1], defCaps[2]) = (1, 2, 4);
        (defPrices[0], defPrices[1], defPrices[2]) = (0.0005 ether, 0.00075 ether, 0.001 ether);
        (defActive[0], defActive[1], defActive[2]) = (true, true, true);
        (defColors[0], defColors[1], defColors[2]) = (0x6366f1, 0x10b981, 0xf59e0b);

        uint256[] memory caps = vm.envOr("TIER_CAPACITIES_GB", ",", defCaps);
        uint256[] memory prices = vm.envOr("TIER_PRICES_WEI", ",", defPrices);
        bool[] memory active = vm.envOr("TIER_ACTIVE", ",", defActive);
        uint256[] memory colors = vm.envOr("TIER_COLORS", ",", defColors);
        uint32[] memory caps32 = new uint32[](caps.length);
        uint24[] memory colors24 = new uint24[](colors.length);
        for (uint256 i; i < caps.length; i++) {
            caps32[i] = uint32(caps[i]);
        }
        for (uint256 i; i < colors.length; i++) {
            colors24[i] = uint24(colors[i]);
        }
        uint96 royalty = uint96(vm.envOr("ROYALTY_BPS", uint256(500)));
        string memory page = vm.envOr("PAGE_BASE", string("https://etherdisk.app/nft/"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);
        EtherdiskRenderer renderer = new EtherdiskRenderer(page);
        Etherdisk disk = new Etherdisk(owner, renderer, caps32, prices, active, colors24, royalty);
        vm.stopBroadcast();
        console.log("Owner:", owner);
        console.log("EtherdiskRenderer deployed at:", address(renderer));
        console.log("Etherdisk deployed at:", address(disk));
    }
}
