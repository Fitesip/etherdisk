// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskArt} from "../src/EtherdiskArt.sol";

/// Exposes the library's internal functions to tests.
contract ArtHarness {
    function svg(uint256 id, uint32 gb) external pure returns (string memory) {
        return EtherdiskArt.svg(id, gb);
    }
}

/// An owner that refuses ETH.
contract Rejecter {
    receive() external payable {
        revert();
    }
}

contract EtherdiskTest is Test {
    Etherdisk disk;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        disk = new Etherdisk(admin);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_initialTiers() public view {
        assertEq(disk.tierCount(), 3);
        assertEq(disk.getTier(0).capacityGb, 1);
        assertEq(disk.getTier(1).capacityGb, 2);
        assertEq(disk.getTier(2).capacityGb, 4);
        assertEq(disk.getTier(0).price, 0.0005 ether);
        assertEq(disk.getTier(2).price, 0.001 ether);
    }

    function test_mint() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.00075 ether}(1);
        assertEq(disk.ownerOf(id), alice);
        assertEq(disk.tierOf(id), 1);
        assertEq(disk.capacityOf(id), 2);
    }

    function test_mintWrongPaymentReverts() public {
        vm.startPrank(alice);
        vm.expectRevert(Etherdisk.WrongPayment.selector);
        disk.mint{value: 0.0004 ether}(0);
        vm.expectRevert(Etherdisk.WrongPayment.selector);
        disk.mint{value: 0.0006 ether}(0);
        vm.stopPrank();
    }

    function test_mintInvalidTierReverts() public {
        vm.prank(alice);
        vm.expectRevert(Etherdisk.InvalidTier.selector);
        disk.mint{value: 1 ether}(99);
    }

    function test_multipleTokensPerWallet() public {
        vm.startPrank(alice);
        disk.mint{value: 0.0005 ether}(0);
        disk.mint{value: 0.001 ether}(2);
        vm.stopPrank();
        uint256[] memory ids = disk.tokensOfOwner(alice);
        assertEq(ids.length, 2);
        assertEq(disk.capacityOf(ids[0]), 1);
        assertEq(disk.capacityOf(ids[1]), 4);
    }

    function test_transferKeepsTier() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        vm.prank(alice);
        disk.transferFrom(alice, bob, id);
        assertEq(disk.ownerOf(id), bob);
        assertEq(disk.capacityOf(id), 4);
        assertEq(disk.tokensOfOwner(alice).length, 0);
        assertEq(disk.tokensOfOwner(bob).length, 1);
    }

    function test_addTierDoesNotAffectExistingTokens() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.0005 ether}(0);
        vm.prank(admin);
        uint256 newTier = disk.addTier(8, 0.002 ether);
        assertEq(newTier, 3);
        assertEq(disk.capacityOf(id), 1);
        vm.prank(bob);
        uint256 id2 = disk.mint{value: 0.002 ether}(newTier);
        assertEq(disk.capacityOf(id2), 8);
    }

    function test_priceChangeAffectsOnlyNewMints() public {
        vm.prank(admin);
        disk.setTierPrice(0, 0.01 ether);
        vm.prank(alice);
        vm.expectRevert(Etherdisk.WrongPayment.selector);
        disk.mint{value: 0.0005 ether}(0);
        vm.prank(alice);
        disk.mint{value: 0.01 ether}(0);
    }

    function test_inactiveTierReverts() public {
        vm.prank(admin);
        disk.setTierActive(0, false);
        vm.prank(alice);
        vm.expectRevert(Etherdisk.TierInactive.selector);
        disk.mint{value: 0.0005 ether}(0);
    }

    function test_addTierZeroCapacityReverts() public {
        vm.prank(admin);
        vm.expectRevert(Etherdisk.ZeroCapacity.selector);
        disk.addTier(0, 1 ether);
    }

    function test_adminFunctionsOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert();
        disk.addTier(8, 1 ether);
        vm.expectRevert();
        disk.setTierPrice(0, 1);
        vm.expectRevert();
        disk.setTierActive(0, false);
        vm.expectRevert();
        disk.withdraw(payable(alice));
        vm.stopPrank();
    }

    function test_mintPaysTheOwner() public {
        vm.prank(alice);
        disk.mint{value: 0.001 ether}(2);
        assertEq(admin.balance, 0.001 ether);
        assertEq(address(disk).balance, 0);

        // A new owner gets the next payments once they accepted.
        vm.prank(admin);
        disk.transferOwnership(bob);
        vm.prank(alice);
        disk.mint{value: 0.0005 ether}(0);
        assertEq(admin.balance, 0.0015 ether, "still the owner until bob accepts");
        vm.prank(bob);
        disk.acceptOwnership();
        uint256 before = bob.balance;
        vm.prank(alice);
        disk.mint{value: 0.0005 ether}(0);
        assertEq(bob.balance, before + 0.0005 ether);
        assertEq(admin.balance, 0.0015 ether);
    }

    function test_paymentStaysWhenTheOwnerRefusesIt() public {
        Rejecter rejecter = new Rejecter();
        vm.prank(admin);
        disk.transferOwnership(address(rejecter));
        vm.prank(address(rejecter));
        disk.acceptOwnership();

        // Minting still works; the payment waits in the contract.
        vm.expectEmit(address(disk));
        emit Etherdisk.PaymentHeld(address(rejecter), 0.001 ether);
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        assertEq(disk.ownerOf(id), alice);
        assertEq(address(disk).balance, 0.001 ether);

        address payable treasury = payable(makeAddr("treasury"));
        vm.prank(address(rejecter));
        disk.withdraw(treasury);
        assertEq(treasury.balance, 0.001 ether);
        assertEq(address(disk).balance, 0);
    }

    function test_withdrawToZeroAddressReverts() public {
        vm.prank(admin);
        vm.expectRevert(Etherdisk.ZeroAddress.selector);
        disk.withdraw(payable(address(0)));
    }

    function test_ownershipNeedsAcceptingAndCantBeRenounced() public {
        // A typo in the address changes nothing: only the named wallet can accept.
        vm.prank(admin);
        disk.transferOwnership(bob);
        assertEq(disk.owner(), admin);
        assertEq(disk.pendingOwner(), bob);
        vm.prank(alice);
        vm.expectRevert();
        disk.acceptOwnership();
        vm.prank(bob);
        disk.acceptOwnership();
        assertEq(disk.owner(), bob);

        vm.prank(bob);
        vm.expectRevert(Etherdisk.RenounceDisabled.selector);
        disk.renounceOwnership();
        vm.prank(alice);
        vm.expectRevert();
        disk.renounceOwnership();
        assertEq(disk.owner(), bob);
    }

    function test_tierOfNonexistentTokenReverts() public {
        vm.expectRevert();
        disk.tierOf(1);
    }

    function testFuzz_mintExactPrice(uint8 tierSeed) public {
        uint256 tierId = tierSeed % 3;
        uint256 price = disk.getTier(tierId).price;
        vm.prank(alice);
        uint256 id = disk.mint{value: price}(tierId);
        assertEq(disk.tierOf(id), tierId);
    }

    // ---------------------------------------------------------------- metadata

    function _has(string memory haystack, string memory needle) internal pure returns (bool) {
        return vm.indexOf(haystack, needle) != type(uint256).max;
    }

    function test_tokenURIIsOnChainJson() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        string memory uri = disk.tokenURI(id);
        assertTrue(_has(uri, "data:application/json;base64,"));
        assertEq(vm.indexOf(uri, "data:application/json;base64,"), 0);
    }

    function test_nameAndSymbol() public view {
        assertEq(disk.name(), "Etherdisk");
        assertEq(disk.symbol(), "DISK");
    }

    function test_tokenURINonexistentReverts() public {
        vm.expectRevert();
        disk.tokenURI(42);
    }

    function test_svgShowsDriveAndCapacity() public {
        ArtHarness art = new ArtHarness();
        string memory s = art.svg(7, 4);
        assertTrue(_has(s, "<svg"));
        assertTrue(_has(s, "Drive #7"));
        assertTrue(_has(s, ">Etherdisk<"));
        assertTrue(_has(s, ">4 GB<"));
        assertTrue(_has(s, "#f59e0b"));
        assertTrue(_has(art.svg(1, 2048), ">2 TB<"));
        assertTrue(_has(art.svg(1, 1536), ">1536 GB<"));
    }
}
