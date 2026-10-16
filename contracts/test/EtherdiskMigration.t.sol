// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Etherdisk} from "../src/Etherdisk.sol";
import {EtherdiskMigration, IEtherdiskLegacy} from "../src/migration/EtherdiskMigration.sol";
import {TestTiers} from "./TestTiers.sol";

/// A minimal successor, as a future contract would use the migration: its own sales (one
/// 8 GB tier here) and swapped legacy drives, all in one id space.
contract Successor is ERC721, Ownable, EtherdiskMigration {
    mapping(uint256 => uint32) public capacityOf;
    uint256 private _next = 1;

    constructor(IEtherdiskLegacy legacy_, address owner_)
        ERC721("Etherdisk", "DISK")
        Ownable(owner_)
        EtherdiskMigration(legacy_)
    {}

    function mint() external returns (uint256 id) {
        id = _nextNewTokenId(_next);
        _next = id + 1;
        capacityOf[id] = 8;
        _mint(msg.sender, id);
    }

    function setMigrationOpen(bool open) external onlyOwner {
        _setMigrationOpen(open);
    }

    function rescueMigration(uint256 tokenId, address holder) external onlyOwner {
        _rescueMigration(tokenId, holder);
    }

    function _mintMigrated(address holder, uint256 tokenId, uint32 capacityGb) internal override {
        capacityOf[tokenId] = capacityGb;
        _mint(holder, tokenId);
    }

    function _existsHere(uint256 tokenId) internal view override returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }
}

/// Another NFT, to check that only legacy drives are swapped.
contract OtherNft is ERC721 {
    constructor() ERC721("Other", "OTH") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract EtherdiskMigrationTest is Test {
    Etherdisk legacy;
    Successor next;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        legacy = TestTiers.deploy(admin);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        // Alice: #1 (1 GB), #3 (4 GB); Bob: #2 (2 GB).
        vm.prank(alice);
        legacy.mint{value: 0.0005 ether}(0);
        vm.prank(bob);
        legacy.mint{value: 0.00075 ether}(1);
        vm.prank(alice);
        legacy.mint{value: 0.001 ether}(2);

        next = new Successor(IEtherdiskLegacy(address(legacy)), admin);
        vm.prank(admin);
        next.setMigrationOpen(true);
    }

    function test_swapInOneTransfer_sameIdAndCapacity() public {
        vm.expectEmit(address(next));
        emit EtherdiskMigration.DriveMigrated(3, alice, 4);
        vm.prank(alice);
        legacy.safeTransferFrom(alice, address(next), 3);

        assertEq(next.ownerOf(3), alice);
        assertEq(next.capacityOf(3), 4);
        assertEq(legacy.ownerOf(3), address(next), "the legacy token is locked in the successor");
    }

    function test_swapByAnApprovedOperatorGoesToTheHolder() public {
        vm.prank(alice);
        legacy.approve(bob, 1);
        vm.prank(bob);
        legacy.safeTransferFrom(alice, address(next), 1);
        assertEq(next.ownerOf(1), alice);
    }

    function test_swapWithApproveAndMigrate() public {
        vm.startPrank(bob);
        legacy.approve(address(next), 2);
        next.migrate(2);
        vm.stopPrank();
        assertEq(next.ownerOf(2), bob);
        assertEq(next.capacityOf(2), 2);
    }

    function test_cannotSwapTwiceOrSwapSomeoneElses() public {
        vm.prank(alice);
        legacy.safeTransferFrom(alice, address(next), 1);
        // The legacy token now belongs to the successor: nobody can send it again.
        vm.prank(alice);
        vm.expectRevert();
        legacy.safeTransferFrom(alice, address(next), 1);
        // migrate() swaps only the caller's own drive, even if its holder approved the successor.
        vm.prank(bob);
        legacy.approve(address(next), 2);
        vm.prank(alice);
        vm.expectRevert();
        next.migrate(2);
        assertEq(legacy.ownerOf(2), bob);
    }

    function test_onlyLegacyDrivesAreSwapped() public {
        OtherNft other = new OtherNft();
        other.mint(alice, 7);
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.NotLegacyToken.selector);
        other.safeTransferFrom(alice, address(next), 7);
        // Calling the hook directly mints nothing either.
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.NotLegacyToken.selector);
        next.onERC721Received(alice, alice, 3, "");
    }

    function test_closedUntilTheOwnerOpensIt() public {
        vm.prank(admin);
        next.setMigrationOpen(false);
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.MigrationClosed.selector);
        legacy.safeTransferFrom(alice, address(next), 1);
        assertEq(legacy.ownerOf(1), alice, "nothing moved");
        vm.prank(alice);
        vm.expectRevert(EtherdiskMigration.MigrationClosed.selector);
        next.migrate(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        next.setMigrationOpen(true);
    }

    function test_newDrivesTakeIdsAfterEveryLegacyDrive() public {
        vm.prank(bob);
        assertEq(next.mint(), 4, "after legacy #3");
        // Legacy sales left open by mistake: the successor still skips the new legacy ids...
        vm.prank(bob);
        legacy.mint{value: 0.0005 ether}(0); // legacy #4, the id the successor already used
        vm.prank(bob);
        legacy.mint{value: 0.0005 ether}(0); // legacy #5
        vm.prank(bob);
        assertEq(next.mint(), 6);
        // ...but legacy #4 collides: its swap reverts as a whole and Bob keeps his legacy drive.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidSender.selector, address(0)));
        legacy.safeTransferFrom(bob, address(next), 4);
        assertEq(legacy.ownerOf(4), bob);
    }

    function test_rescueADriveSentWithPlainTransfer() public {
        // transferFrom has no callback: the drive is locked here without a swap.
        vm.prank(alice);
        legacy.transferFrom(alice, address(next), 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        next.ownerOf(1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        next.rescueMigration(1, alice);
        vm.prank(admin);
        next.rescueMigration(1, alice);
        assertEq(next.ownerOf(1), alice);
        assertEq(next.capacityOf(1), 1);

        // Only for a drive that is locked here and not yet swapped.
        vm.startPrank(admin);
        vm.expectRevert(EtherdiskMigration.NotStuck.selector);
        next.rescueMigration(1, alice);
        vm.expectRevert(EtherdiskMigration.NotStuck.selector);
        next.rescueMigration(2, admin);
        vm.stopPrank();
    }
}
