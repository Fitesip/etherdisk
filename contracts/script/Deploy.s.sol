// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Etherdisk} from "../src/Etherdisk.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Etherdisk disk = new Etherdisk(deployer);
        vm.stopBroadcast();
        console.log("Owner:", deployer);
        console.log("Etherdisk deployed at:", address(disk));
    }
}
