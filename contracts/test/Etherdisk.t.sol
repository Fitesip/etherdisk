// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Etherdisk} from "../src/Etherdisk.sol";
import {TestTiers} from "./TestTiers.sol";
import {EtherdiskArt} from "../src/EtherdiskArt.sol";
import {EtherdiskRenderer} from "../src/EtherdiskRenderer.sol";
import {IEtherdiskRenderer} from "../src/IEtherdiskRenderer.sol";
import {IEtherdiskLegacy} from "../src/migration/EtherdiskMigration.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

/// Exposes the library's internal functions to tests.
contract ArtHarness {
    function svg(uint256 id, uint32 gb, uint24 rgb) external pure returns (string memory) {
        return EtherdiskArt.svg(id, gb, rgb, 0);
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
        disk = TestTiers.deploy(admin);
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
        assertEq(disk.balanceOf(alice), 2);
        assertEq(disk.totalSupply(), 2);
        assertEq(disk.capacityOf(1), 1);
        assertEq(disk.capacityOf(2), 4);
    }

    function test_transferKeepsTier() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        vm.prank(alice);
        disk.transferFrom(alice, bob, id);
        assertEq(disk.ownerOf(id), bob);
        assertEq(disk.capacityOf(id), 4);
        assertEq(disk.balanceOf(alice), 0);
        assertEq(disk.balanceOf(bob), 1);
    }

    function test_addTierDoesNotAffectExistingTokens() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.0005 ether}(0);
        vm.prank(admin);
        uint256 newTier = disk.addTier(8, 0.002 ether, 0x123456);
        assertEq(newTier, 3);
        assertEq(disk.capacityOf(id), 1);
        // A new tier isn't on sale until it is opened.
        assertFalse(disk.getTier(newTier).active);
        vm.prank(bob);
        vm.expectRevert(Etherdisk.TierInactive.selector);
        disk.mint{value: 0.002 ether}(newTier);
        vm.prank(admin);
        disk.setTierActive(newTier, true);
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
        disk.addTier(0, 1 ether, 0);
    }

    function test_adminFunctionsOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert();
        disk.addTier(8, 1 ether, 0);
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

    function _count(string memory haystack, string memory needle) internal pure returns (uint256 n) {
        bytes memory h = bytes(haystack);
        bytes memory nd = bytes(needle);
        for (uint256 i; i + nd.length <= h.length; i++) {
            bool same = true;
            for (uint256 k; k < nd.length && same; k++) {
                same = h[i + k] == nd[k];
            }
            if (same) n++;
        }
    }

    function test_svgShowsNumberCapacityAndTierColor() public {
        ArtHarness art = new ArtHarness();
        string memory s = art.svg(7, 4, 0xf59e0b);
        assertTrue(_has(s, "<svg"));
        assertTrue(_has(s, ">ETHERDISK<"));
        assertTrue(_has(s, ">#7<"));
        assertTrue(_has(s, ">4 GB<"));
        assertTrue(_has(s, "#f59e0b"));
        assertTrue(_has(art.svg(1, 2048, 0), ">2 TB<"));
        assertTrue(_has(art.svg(1, 1536, 0), ">1536 GB<"));
        // Leading zeros and every digit of the color survive.
        assertTrue(_has(art.svg(1, 1, 0x0a0b0c), "#0a0b0c"));
        assertTrue(_has(art.svg(1, 1, 0xfedcba), "#fedcba"));
    }

    /// Bigger drives get more tracks; each in its tier's color.
    function test_mainnetTiersLookDifferent() public {
        ArtHarness art = new ArtHarness();
        string[6] memory colors = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#a855f7"];
        uint24[6] memory rgb = [uint24(0x6366f1), 0x10b981, 0xf59e0b, 0xec4899, 0x0ea5e9, 0xa855f7];
        uint32[6] memory sizes = [uint32(64), 128, 256, 512, 1024, 2048];
        uint256 lastRings;
        for (uint256 i; i < 6; i++) {
            string memory s = art.svg(1, sizes[i], rgb[i]);
            assertTrue(_has(s, colors[i]), "tier color");
            uint256 rings = _count(s, 'cx="200" cy="220" r="') - 2; // minus the platter and the hub
            assertGe(rings, lastRings, "tracks don't shrink");
            lastRings = rings;
        }
        assertEq(lastRings, 9);
    }

    function test_tiersComeFromTheConstructor() public {
        uint32[] memory caps = new uint32[](6);
        uint256[] memory prices = new uint256[](6);
        bool[] memory active = new bool[](6);
        uint24[] memory colors = new uint24[](6);
        for (uint256 i; i < 6; i++) {
            caps[i] = uint32(64 << i);
            prices[i] = (i + 1) * 0.01 ether;
            active[i] = i < 3;
            colors[i] = uint24(0x101010 * (i + 1));
        }
        IEtherdiskRenderer r = new EtherdiskRenderer(TestTiers.PAGE);
        Etherdisk main = new Etherdisk(admin, r, caps, prices, active, colors, 500, IEtherdiskLegacy(address(0)));
        assertEq(main.tierCount(), 6);
        assertEq(main.getTier(5).capacityGb, 2048);
        assertEq(main.getTier(5).color, 0x606060);
        assertFalse(main.getTier(5).hidden);
        assertTrue(main.getTier(2).active);
        assertFalse(main.getTier(3).active, "512 GB: coming soon");

        vm.prank(alice);
        main.mint{value: 0.03 ether}(2);
        vm.prank(alice);
        vm.expectRevert(Etherdisk.TierInactive.selector);
        main.mint{value: 0.04 ether}(3);

        bool[] memory short = new bool[](5);
        vm.expectRevert(Etherdisk.TiersMismatch.selector);
        new Etherdisk(admin, r, caps, prices, short, colors, 500, IEtherdiskLegacy(address(0)));
        vm.expectRevert(Etherdisk.TiersMismatch.selector);
        new Etherdisk(admin, r, caps, prices, active, new uint24[](5), 500, IEtherdiskLegacy(address(0)));
        vm.expectRevert(Etherdisk.ZeroAddress.selector);
        new Etherdisk(admin, IEtherdiskRenderer(address(0)), caps, prices, active, colors, 500, IEtherdiskLegacy(address(0)));
        vm.expectRevert(Etherdisk.RoyaltyTooHigh.selector);
        new Etherdisk(admin, r, caps, prices, active, colors, 1001, IEtherdiskLegacy(address(0)));
        caps[0] = 0;
        vm.expectRevert(Etherdisk.ZeroCapacity.selector);
        new Etherdisk(admin, r, caps, prices, active, colors, 500, IEtherdiskLegacy(address(0)));
    }

    function test_operatorsOpenAndCloseSalesOnly() public {
        address moderator = makeAddr("moderator");
        vm.prank(moderator);
        vm.expectRevert(Etherdisk.NotOperator.selector);
        disk.setTierActive(0, false);

        vm.prank(alice);
        vm.expectRevert();
        disk.setOperator(moderator, true);
        vm.prank(admin);
        disk.setOperator(moderator, true);
        assertTrue(disk.isOperator(moderator));

        vm.prank(moderator);
        disk.setTierActive(0, false);
        assertFalse(disk.getTier(0).active);
        vm.prank(moderator);
        disk.setTierActive(0, true);
        // Prices, tiers and money stay with the owner.
        vm.startPrank(moderator);
        vm.expectRevert();
        disk.setTierPrice(0, 1);
        vm.expectRevert();
        disk.addTier(8, 1 ether, 0);
        vm.expectRevert();
        disk.setTierColor(0, 0);
        vm.expectRevert();
        disk.setRenderer(IEtherdiskRenderer(address(1)));
        vm.expectRevert();
        disk.freezeMetadata();
        vm.expectRevert();
        disk.setRoyalty(moderator, 0);
        vm.expectRevert();
        disk.withdraw(payable(moderator));
        // Hiding a tier from the site is theirs too.
        disk.setTierHidden(1, true);
        assertTrue(disk.getTier(1).hidden);
        disk.setTierHidden(1, false);
        vm.stopPrank();

        vm.prank(admin);
        disk.setOperator(moderator, false);
        vm.prank(moderator);
        vm.expectRevert(Etherdisk.NotOperator.selector);
        disk.setTierActive(0, false);
    }

    // ---------------------------------------------------------------- metadata, tiers, royalties

    function _json(uint256 id) internal view returns (string memory) {
        Etherdisk.Tier memory t = disk.getTier(disk.tierOf(id));
        return EtherdiskRenderer(address(disk.renderer())).json(id, t.capacityGb, t.color, 1, address(0));
    }

    function test_metadataHasOneCapacityTraitAndTheDrivePage() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        string memory j = _json(id);
        assertEq(vm.parseJsonString(j, ".name"), "Etherdisk #1");
        assertEq(vm.parseJsonString(j, ".external_url"), "https://etherdisk.app/nft/1");
        assertEq(vm.parseJsonString(j, ".attributes[0].trait_type"), "Capacity");
        assertEq(vm.parseJsonString(j, ".attributes[0].value"), "4 GB");
        assertFalse(vm.keyExistsJson(j, ".attributes[1]"), "one trait only");
        assertTrue(_has(vm.parseJsonString(j, ".description"), "hands over the drive key"));
        assertTrue(_has(vm.parseJsonString(j, ".image"), "data:image/svg+xml;base64,"));
        // tokenURI is the same JSON, base64 in a data URI.
        assertEq(disk.tokenURI(id), string.concat("data:application/json;base64,", vm.toBase64(bytes(j))));
    }

    function test_recoloringATierRefreshesMarketplaces() public {
        vm.prank(alice);
        uint256 id = disk.mint{value: 0.001 ether}(2);
        vm.prank(bob);
        disk.mint{value: 0.0005 ether}(0);
        assertTrue(_has(_json(id), vm.toBase64(bytes(EtherdiskArt.svg(id, 4, 0xf59e0b, 0)))));

        vm.expectEmit(address(disk));
        emit Etherdisk.TierColorUpdated(2, 0x00ff00);
        vm.expectEmit(address(disk));
        emit IERC4906.BatchMetadataUpdate(1, 2);
        vm.prank(admin);
        disk.setTierColor(2, 0x00ff00);
        assertEq(disk.getTier(2).color, 0x00ff00);
        assertEq(disk.getTier(0).color, 0x6366f1, "other tiers keep theirs");
    }

    function test_hiddenTiersStayMintableUnlessClosed() public {
        vm.expectEmit(address(disk));
        emit Etherdisk.TierHiddenUpdated(1, true);
        vm.prank(admin);
        disk.setTierHidden(1, true);
        assertTrue(disk.getTier(1).hidden);
        // Hiding is about the site's list; sales are setTierActive's.
        vm.prank(alice);
        disk.mint{value: 0.00075 ether}(1);
        vm.prank(admin);
        vm.expectRevert(Etherdisk.InvalidTier.selector);
        disk.setTierHidden(9, true);
        vm.prank(alice);
        vm.expectRevert(Etherdisk.NotOperator.selector);
        disk.setTierHidden(0, true);
    }

    function test_rendererCanBeReplacedUntilFrozen() public {
        vm.prank(alice);
        disk.mint{value: 0.0005 ether}(0);
        EtherdiskRenderer next = new EtherdiskRenderer("https://example.org/d/");
        vm.expectEmit(address(disk));
        emit Etherdisk.RendererSet(address(next));
        vm.expectEmit(address(disk));
        emit IERC4906.BatchMetadataUpdate(1, 1);
        vm.prank(admin);
        disk.setRenderer(next);
        assertEq(address(disk.renderer()), address(next));
        assertEq(vm.parseJsonString(_json(1), ".external_url"), "https://example.org/d/1");

        vm.prank(admin);
        vm.expectRevert(Etherdisk.ZeroAddress.selector);
        disk.setRenderer(IEtherdiskRenderer(address(0)));

        vm.prank(alice);
        vm.expectRevert();
        disk.freezeMetadata();
        vm.expectEmit(address(disk));
        emit Etherdisk.MetadataFrozen();
        vm.prank(admin);
        disk.freezeMetadata();
        assertTrue(disk.metadataFrozen());
        vm.startPrank(admin);
        vm.expectRevert(Etherdisk.MetadataIsFrozen.selector);
        disk.setRenderer(new EtherdiskRenderer(TestTiers.PAGE));
        vm.expectRevert(Etherdisk.MetadataIsFrozen.selector);
        disk.setTierColor(0, 0);
        vm.stopPrank();
    }

    function test_noRefreshEventBeforeTheFirstDrive() public {
        vm.recordLogs();
        vm.prank(admin);
        disk.setTierColor(0, 1);
        bytes32 batch = keccak256("BatchMetadataUpdate(uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != batch);
        }
    }

    function test_royaltiesGoToTheOwnerAndAreCapped() public {
        (address to, uint256 amount) = disk.royaltyInfo(1, 1 ether);
        assertEq(to, admin);
        assertEq(amount, 0.05 ether);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        disk.setRoyalty(treasury, 250);
        (to, amount) = disk.royaltyInfo(1, 1 ether);
        assertEq(to, treasury);
        assertEq(amount, 0.025 ether);
        vm.prank(admin);
        vm.expectRevert(Etherdisk.RoyaltyTooHigh.selector);
        disk.setRoyalty(treasury, 1001);
    }

    function test_supportedInterfaces() public view {
        assertTrue(disk.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(disk.supportsInterface(0x5b5e139f), "ERC-721 metadata");
        assertTrue(disk.supportsInterface(0x2a55205a), "ERC-2981");
        assertTrue(disk.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(disk.supportsInterface(0x01ffc9a7), "ERC-165");
        assertFalse(disk.supportsInterface(0xffffffff));
    }
}
