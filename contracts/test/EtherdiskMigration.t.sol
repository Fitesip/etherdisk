// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskMigration, IEtherdiskLegacy} from "../src/migration/EtherdiskMigration.sol";
import {EtherdiskRenderer} from "../src/EtherdiskRenderer.sol";
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
        // v1 hands over to v2 (its sales end for good), then v2 opens moves.
        v2 = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(v1)));
        vm.startPrank(admin);
        v1.setSuccessor(address(v2));
        v2.setMigrationOpen(true);
        vm.stopPrank();
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

    function test_anyoneCompletesAMoveSentWithPlainTransfer_forItsSender() public {
        vm.prank(alice);
        v1.transferFrom(alice, address(v2), 3);
        assertEq(v1.ownerOf(3), address(v2), "stuck: no move without the callback");
        assertEq(v1.sentToSuccessorBy(3), alice);
        // Bob finishes it, but the drive is Alice's: the old contract recorded the sender.
        vm.prank(bob);
        v2.completeMigration(3);
        assertEq(v2.ownerOf(3), alice);
        assertEq(v1.ownerOf(3), admin);
        vm.expectRevert(EtherdiskMigration.NotStuck.selector);
        v2.completeMigration(3);
        // Nothing to complete for a drive that wasn't sent.
        vm.expectRevert(EtherdiskMigration.NotStuck.selector);
        v2.completeMigration(2);
    }

    function test_aCapacityWithoutATierHereNeedsOneAdded() public {
        // An 8 GB drive on an old contract whose successor has no 8 GB tier.
        Etherdisk old = TestTiers.deploy(admin);
        vm.startPrank(admin);
        uint256 t8 = old.addTier(8, 0.002 ether, 0x123456);
        old.setTierActive(t8, true);
        vm.stopPrank();
        vm.prank(bob);
        uint256 id = old.mint{value: 0.002 ether}(t8);
        vm.startPrank(admin);
        Etherdisk next = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(old)));
        old.setSuccessor(address(next));
        next.setMigrationOpen(true);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Etherdisk.NoTierForCapacity.selector, uint32(8)));
        old.safeTransferFrom(bob, address(next), id);
        vm.prank(admin);
        uint256 here = next.addTier(8, 0, 0xabcdef);
        vm.prank(admin);
        next.setTierHidden(here, true);
        vm.prank(bob);
        old.safeTransferFrom(bob, address(next), id);
        assertEq(next.capacityOf(id), 8);
        assertEq(next.tierOf(id), here);
    }

    /// No id twice: the new contract neither mints nor takes moves until the old one has
    /// handed over to it, which ends the old one's sales for good.
    function test_nothingUntilTheOldContractHandsOver() public {
        Etherdisk old = TestTiers.deploy(admin);
        Etherdisk next = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(old)));
        vm.prank(admin);
        vm.expectRevert(EtherdiskMigration.LegacyNotHandedOver.selector);
        next.setMigrationOpen(true);
        vm.prank(bob);
        vm.expectRevert(EtherdiskMigration.LegacyNotHandedOver.selector);
        next.mint{value: 0.0005 ether}(0);

        // Only the owner hands over, only to a contract built on it, and once.
        vm.prank(bob);
        vm.expectRevert();
        old.setSuccessor(address(next));
        vm.startPrank(admin);
        vm.expectRevert(EtherdiskMigration.NotSuccessor.selector);
        old.setSuccessor(address(v2));
        vm.expectRevert(EtherdiskMigration.NotSuccessor.selector);
        old.setSuccessor(address(0));
        old.setSuccessor(address(next));
        vm.expectRevert(EtherdiskMigration.SuccessorAlreadySet.selector);
        old.setSuccessor(address(next));
        // No tier sells on the old one after that.
        old.setTierActive(0, true);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(EtherdiskMigration.SalesClosedForGood.selector);
        old.mint{value: 0.0005 ether}(0);

        vm.prank(admin);
        next.setMigrationOpen(true);
        vm.prank(bob);
        assertEq(next.mint{value: 0.0005 ether}(0), 1);
    }

    /// The old token of a moved drive shows as a legacy one, with its version.
    function test_aMovedDrivesOldTokenIsLegacy() public {
        assertEq(v1.version(), 1);
        assertEq(v2.version(), 2);
        string memory before = v1.tokenURI(3);
        vm.expectEmit(address(v1));
        emit IERC4906.MetadataUpdate(3);
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 3);

        EtherdiskRenderer r = EtherdiskRenderer(address(v1.renderer()));
        string memory j = r.json(3, 4, 0xf59e0b, 1, address(v2));
        assertEq(v1.tokenURI(3), _uri(j));
        assertTrue(keccak256(bytes(v1.tokenURI(3))) != keccak256(bytes(before)));
        assertEq(vm.parseJsonString(j, ".name"), unicode"Etherdisk #3 · Legacy v1");
        assertEq(vm.parseJsonString(j, ".attributes[0].value"), "4 GB");
        assertEq(vm.parseJsonString(j, ".attributes[1].trait_type"), "Status");
        assertEq(vm.parseJsonString(j, ".attributes[1].value"), "Legacy");
        assertEq(vm.parseJsonString(j, ".attributes[2].trait_type"), "Version");
        assertEq(vm.parseJsonString(j, ".attributes[2].value"), "v1");
        string memory text = vm.parseJsonString(j, ".description");
        assertTrue(_has(text, "moved to Etherdisk v2"));
        assertTrue(_has(text, vm.toLowercase(vm.toString(address(v2)))));

        // A drive that hasn't moved, and the moved drive on v2, look as usual.
        assertEq(v1.tokenURI(1), _uri(r.json(1, 1, 0x6366f1, 1, address(0))));
        EtherdiskRenderer r2 = EtherdiskRenderer(address(v2.renderer()));
        assertEq(v2.tokenURI(3), _uri(r2.json(3, 4, 0xf59e0b, 2, address(0))));
    }

    /// A drive stuck in the new contract (plain transfer) isn't legacy until its move completes.
    function test_aStuckDriveIsNotLegacyYet() public {
        vm.prank(alice);
        v1.transferFrom(alice, address(v2), 3);
        EtherdiskRenderer r = EtherdiskRenderer(address(v1.renderer()));
        assertEq(v1.tokenURI(3), _uri(r.json(3, 4, 0xf59e0b, 1, address(0))));
    }

    function _uri(string memory json) private pure returns (string memory) {
        return string.concat("data:application/json;base64,", vm.toBase64(bytes(json)));
    }

    function _has(string memory hay, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        for (uint256 i; i + n.length <= h.length; i++) {
            bool ok = true;
            for (uint256 k; k < n.length && ok; k++) {
                ok = h[i + k] == n[k];
            }
            if (ok) return true;
        }
        return false;
    }

    /// v1 → v2 → v3: each version takes the previous one's drives, one step at a time.
    function test_drivesMoveAlongTheChainOfVersions() public {
        vm.prank(alice);
        v1.safeTransferFrom(alice, address(v2), 1);
        vm.prank(bob);
        uint256 newOnV2 = v2.mint{value: 0.0005 ether}(0);
        vm.startPrank(admin);
        Etherdisk v3 = TestTiers.deployAfter(admin, IEtherdiskLegacy(address(v2)));
        v2.setSuccessor(address(v3));
        v3.setMigrationOpen(true);
        vm.stopPrank();

        assertEq(v3.version(), 3);
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
