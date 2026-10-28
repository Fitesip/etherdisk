// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskMigration, IEtherdiskLegacy} from "../src/migration/EtherdiskMigration.sol";
import {TestTiers} from "./TestTiers.sol";

/// Another NFT, to check that only legacy drives move.
contract OtherNft is ERC721 {
    constructor() ERC721("Other", "OTH") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract EtherdiskMigrationTest is Test {
    Etherdisk v1;
    Etherdisk v2;
    address admin = makeAddr("admin"); // the Safe
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        v1 = TestTiers.deploy(admin);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        // Alice: #1 (1 GB), #3 (4 GB); Bob: #2 (2 GB).
        vm.prank(alice);
        v1.mint{value: 0.0005 ether}(0);
        vm.prank(bob);
        v1.mint{value: 0.00075 ether}(1);
        vm.prank(alice);
        v1.mint{value: 0.001 ether}(2);
        // The old contract's sales close for good before the new one.
        vm.startPrank(admin);
        for (uint256 i; i < 3; i++) {
            v1.setTierActive(i, false);
        }
        vm.stopPrank();

        v2 = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(v1)));
        vm.prank(admin);
        v2.setMigrationOpen(true);
    }

    function test_moveInOneTransfer_sameIdAndCapacity_oldTokenToTheSafe() public {
        vm.expectEmit(address(v2));
        emit EtherdiskMigration.DriveMigrated(3, alice, 4);
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 3);
        assertEq(v2.ownerOf(3), alice);
        assertEq(v2.capacityOf(3), 4);
        assertEq(v2.tierOf(3), 2, "the tier of its capacity here");
        assertEq(v1.ownerOf(3), admin, "the old token went to the Safe");
        assertEq(v1.balanceOf(address(v2)), 0, "nothing stays in the new contract");
    }

    function test_movedByAnApprovedOperatorGoesToTheHolder() public {
        address op = makeAddr("operator");
        vm.prank(alice);
        v1.setApprovalForAll(op, true);
        vm.prank(op);
        v1.safeTransferFrom(alice, address(v2), 1);
        assertEq(v2.ownerOf(1), alice);
    }

    function test_moveWithApproveAndMigrate() public {
        vm.prank(bob);
        v1.approve(address(v2), 2);
        vm.prank(bob);
        v2.migrate(2);
        assertEq(v2.ownerOf(2), bob);
        assertEq(v2.capacityOf(2), 2);
        assertEq(v1.ownerOf(2), admin);
    }

    function test_cannotMoveTwiceOrMoveSomeoneElses() public {
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 1);
        // The Safe holds the old token; sending it back can't mint #1 again.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidSender.selector, address(0)));
        v1.safeTransferFrom(admin, address(v2), 1);
        assertEq(v1.ownerOf(1), admin, "the whole move reverted");
        // Bob can't move Alice's drive.
        vm.prank(bob);
        vm.expectRevert();
        v2.migrate(3);
        assertEq(v1.ownerOf(3), alice);
    }

    function test_onlyLegacyDrivesMove() public {
        OtherNft other = new OtherNft();
        other.mint(alice, 7);
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.NotLegacyToken.selector);
        other.safeTransferFrom(alice, address(v2), 7);
    }

    function test_closedUntilTheOwnerOpensIt() public {
        Etherdisk closed = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(v1)));
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.MigrationClosed.selector);
        v1.safeTransferFrom(alice, address(closed), 1);
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.MigrationClosed.selector);
        closed.migrate(1);
        vm.prank(alice);
        vm.expectRevert();
        closed.setMigrationOpen(true);
    }

    function test_newDrivesTakeIdsAfterEveryLegacyDrive() public {
        // Before any new drive, totalSupply already covers the legacy ids.
        assertEq(v2.totalSupply(), 3);
        vm.prank(bob);
        uint256 id = v2.mint{value: 0.0005 ether}(0);
        assertEq(id, 4);
        assertEq(v2.totalSupply(), 4);
        // Legacy drives still move with their own ids afterwards.
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 1);
        assertEq(v2.ownerOf(1), alice);
        assertEq(v2.totalSupply(), 4);
    }

    function test_rescueADriveSentWithPlainTransfer() public {
        vm.prank(alice);
        v1.transferFrom(alice, address(v2), 3);
        assertEq(v1.ownerOf(3), address(v2), "stuck: no move without the callback");
        vm.prank(alice);
        vm.expectRevert();
        v2.rescueMigration(3, alice);
        vm.prank(admin);
        v2.rescueMigration(3, alice);
        assertEq(v2.ownerOf(3), alice);
        assertEq(v1.ownerOf(3), admin);
        vm.prank(admin);
        vm.expectRevert(EtherdiskMigration.NotStuck.selector);
        v2.rescueMigration(3, alice);
    }

    function test_aCapacityWithoutATierHereNeedsOneAdded() public {
        // An 8 GB tier on the old contract that the new one doesn't have.
        vm.startPrank(admin);
        uint256 t8 = v1.addTier(8, 0.002 ether, 0x123456);
        v1.setTierActive(t8, true);
        vm.stopPrank();
        vm.prank(bob);
        uint256 id = v1.mint{value: 0.002 ether}(t8);
        // The new contract's ids still come after it.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Etherdisk.NoTierForCapacity.selector, uint32(8)));
        v1.safeTransferFrom(bob, address(v2), id);
        vm.prank(admin);
        uint256 here = v2.addTier(8, 0, 0xabcdef);
        vm.prank(admin);
        v2.setTierHidden(here, true);
        vm.prank(bob);
        v1.safeTransferFrom(bob, address(v2), id);
        assertEq(v2.capacityOf(id), 8);
        assertEq(v2.tierOf(id), here);
    }

    /// v1 → v2 → v3: each version takes the previous one's drives, one step at a time.
    function test_drivesMoveAlongTheChainOfVersions() public {
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 1);
        vm.prank(bob);
        uint256 newOnV2 = v2.mint{value: 0.0005 ether}(0);
        vm.startPrank(admin);
        for (uint256 i; i < 3; i++) {
            v2.setTierActive(i, false);
        }
        Etherdisk v3 = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(v2)));
        v3.setMigrationOpen(true);
        vm.stopPrank();

        assertEq(v3.totalSupply(), 4, "after every v1 and v2 id");
        vm.prank(alice);
        v2.safeTransferFrom(alice, address(v3), 1);
        vm.prank(bob);
        v2.safeTransferFrom(bob, address(v3), newOnV2);
        assertEq(v3.ownerOf(1), alice);
        assertEq(v3.ownerOf(newOnV2), bob);
        assertEq(v2.ownerOf(1), admin);

        // A drive still on v1 goes through v2 first.
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.NotLegacyToken.selector);
        v1.safeTransferFrom(alice, address(v3), 3);
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 3);
        vm.prank(alice);
        v2.safeTransferFrom(alice, address(v3), 3);
        assertEq(v3.ownerOf(3), alice);
        assertEq(v3.capacityOf(3), 4);
        uint256 free = _freeTier(v3);
        vm.prank(alice);
        uint256 next = v3.mint{value: 0}(free);
        assertEq(next, 5);
    }

    function test_theFirstContractHasNothingToMove() public {
        assertEq(address(v1.legacy()), address(0));
        vm.prank(admin);
        v1.setMigrationOpen(true);
        vm.prank(alice);
        vm.expectRevert();
        v1.migrate(1);
        OtherNft other = new OtherNft();
        other.mint(alice, 7);
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.NotLegacyToken.selector);
        other.safeTransferFrom(alice, address(v1), 7);
    }

    /// A free tier on sale, to mint without fuss.
    function _freeTier(Etherdisk d) private returns (uint256 t) {
        vm.startPrank(admin);
        t = d.addTier(16, 0, 0);
        d.setTierActive(t, true);
        vm.stopPrank();
    }
}
