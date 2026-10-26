// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskRenderer} from "../src/EtherdiskRenderer.sol";

/// The testnet tiers (1, 2, 4 GB), all on sale, in the colors of the first three sizes;
/// 5% royalty to the owner.
library TestTiers {
    string internal constant PAGE = "https://etherdisk.app/nft/";

    function deploy(address owner) internal returns (Etherdisk) {
        uint32[] memory caps = new uint32[](3);
        uint256[] memory prices = new uint256[](3);
        bool[] memory active = new bool[](3);
        uint24[] memory colors = new uint24[](3);
        (caps[0], caps[1], caps[2]) = (1, 2, 4);
        (prices[0], prices[1], prices[2]) = (0.0005 ether, 0.00075 ether, 0.001 ether);
        (active[0], active[1], active[2]) = (true, true, true);
        (colors[0], colors[1], colors[2]) = (0x6366f1, 0x10b981, 0xf59e0b);
        return new Etherdisk(owner, new EtherdiskRenderer(PAGE), caps, prices, active, colors, 500);
    }
}
