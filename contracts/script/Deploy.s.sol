// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VaultNFT} from "../src/VaultNFT.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        VaultNFT vault = new VaultNFT(deployer);
        vm.stopBroadcast();
        console.log("Owner:", deployer);
        console.log("VaultNFT deployed at:", address(vault));
    }
}
