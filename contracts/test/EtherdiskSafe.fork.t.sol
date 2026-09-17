// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Etherdisk} from "../src/Etherdisk.sol";
import {TestTiers} from "./TestTiers.sol";

/// Mint payments reach a real Safe (v1.4.1) owner within the payout gas limit.
/// Runs on a mainnet fork: MAINNET_RPC_URL=<url> forge test --match-contract Safe
contract EtherdiskSafeForkTest is Test {
    /// A SafeL2 1.4.1 proxy created on mainnet (ProxyCreation from the 1.4.1 factory).
    address constant SAFE = 0x65d34F6e1EbDDa8a32Db368089e907368Aa7f849;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function test_mintPaysASafeOwner() public {
        assertGt(SAFE.code.length, 0, "not a contract on this fork");
        Etherdisk disk = TestTiers.deploy(SAFE);
        // A fresh address: well-known labels like "alice" already hold code on mainnet.
        address alice = address(uint160(uint256(keccak256("etherdisk safe fork minter"))));
        assertEq(alice.code.length, 0);
        vm.deal(alice, 1 ether);
        uint256 before = SAFE.balance;
        // The test deployer's addresses may already hold stray ETH on mainnet.
        uint256 kept = address(disk).balance;

        vm.recordLogs();
        vm.prank(alice);
        disk.mint{value: 0.001 ether}(2);

        assertEq(SAFE.balance, before + 0.001 ether, "the Safe got the payment");
        assertEq(address(disk).balance, kept, "nothing held back");
        bytes32 held = keccak256("PaymentHeld(address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != held, "payout failed");
        }
    }
}
