// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultNFT} from "../src/VaultNFT.sol";

contract VaultNFTTest is Test {
    VaultNFT vault;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vault = new VaultNFT(admin);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_initialTiers() public view {
        assertEq(vault.tierCount(), 3);
        assertEq(vault.getTier(0).capacityGb, 1);
        assertEq(vault.getTier(1).capacityGb, 2);
        assertEq(vault.getTier(2).capacityGb, 4);
        assertEq(vault.getTier(0).price, 0.0005 ether);
        assertEq(vault.getTier(2).price, 0.001 ether);
    }

    function test_mint() public {
        vm.prank(alice);
        uint256 id = vault.mint{value: 0.00075 ether}(1);
        assertEq(vault.ownerOf(id), alice);
        assertEq(vault.tierOf(id), 1);
        assertEq(vault.capacityOf(id), 2);
    }

    function test_mintWrongPaymentReverts() public {
        vm.startPrank(alice);
        vm.expectRevert(VaultNFT.WrongPayment.selector);
        vault.mint{value: 0.0004 ether}(0);
        vm.expectRevert(VaultNFT.WrongPayment.selector);
        vault.mint{value: 0.0006 ether}(0);
        vm.stopPrank();
    }

    function test_mintInvalidTierReverts() public {
        vm.prank(alice);
        vm.expectRevert(VaultNFT.InvalidTier.selector);
        vault.mint{value: 1 ether}(99);
    }

    function test_multipleTokensPerWallet() public {
        vm.startPrank(alice);
        vault.mint{value: 0.0005 ether}(0);
        vault.mint{value: 0.001 ether}(2);
        vm.stopPrank();
        uint256[] memory ids = vault.tokensOfOwner(alice);
        assertEq(ids.length, 2);
        assertEq(vault.capacityOf(ids[0]), 1);
        assertEq(vault.capacityOf(ids[1]), 4);
    }

    function test_transferKeepsTier() public {
        vm.prank(alice);
        uint256 id = vault.mint{value: 0.001 ether}(2);
        vm.prank(alice);
        vault.transferFrom(alice, bob, id);
        assertEq(vault.ownerOf(id), bob);
        assertEq(vault.capacityOf(id), 4);
        assertEq(vault.tokensOfOwner(alice).length, 0);
        assertEq(vault.tokensOfOwner(bob).length, 1);
    }

    function test_addTierDoesNotAffectExistingTokens() public {
        vm.prank(alice);
        uint256 id = vault.mint{value: 0.0005 ether}(0);
        vm.prank(admin);
        uint256 newTier = vault.addTier(8, 0.002 ether);
        assertEq(newTier, 3);
        assertEq(vault.capacityOf(id), 1);
        vm.prank(bob);
        uint256 id2 = vault.mint{value: 0.002 ether}(newTier);
        assertEq(vault.capacityOf(id2), 8);
    }

    function test_priceChangeAffectsOnlyNewMints() public {
        vm.prank(admin);
        vault.setTierPrice(0, 0.01 ether);
        vm.prank(alice);
        vm.expectRevert(VaultNFT.WrongPayment.selector);
        vault.mint{value: 0.0005 ether}(0);
        vm.prank(alice);
        vault.mint{value: 0.01 ether}(0);
    }

    function test_inactiveTierReverts() public {
        vm.prank(admin);
        vault.setTierActive(0, false);
        vm.prank(alice);
        vm.expectRevert(VaultNFT.TierInactive.selector);
        vault.mint{value: 0.0005 ether}(0);
    }

    function test_addTierZeroCapacityReverts() public {
        vm.prank(admin);
        vm.expectRevert(VaultNFT.ZeroCapacity.selector);
        vault.addTier(0, 1 ether);
    }

    function test_adminFunctionsOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert();
        vault.addTier(8, 1 ether);
        vm.expectRevert();
        vault.setTierPrice(0, 1);
        vm.expectRevert();
        vault.setTierActive(0, false);
        vm.expectRevert();
        vault.withdraw(payable(alice));
        vm.stopPrank();
    }

    function test_withdraw() public {
        vm.prank(alice);
        vault.mint{value: 0.001 ether}(2);
        address payable treasury = payable(makeAddr("treasury"));
        vm.prank(admin);
        vault.withdraw(treasury);
        assertEq(treasury.balance, 0.001 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_tierOfNonexistentTokenReverts() public {
        vm.expectRevert();
        vault.tierOf(1);
    }

    function testFuzz_mintExactPrice(uint8 tierSeed) public {
        uint256 tierId = tierSeed % 3;
        uint256 price = vault.getTier(tierId).price;
        vm.prank(alice);
        uint256 id = vault.mint{value: price}(tierId);
        assertEq(vault.tierOf(id), tierId);
    }
}
