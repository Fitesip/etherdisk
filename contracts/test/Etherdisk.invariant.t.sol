// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Etherdisk} from "../src/Etherdisk.sol";
import {TestTiers} from "./TestTiers.sol";

/// An owner that refuses ETH: its payments stay in the contract.
contract Refuser {
    receive() external payable {
        revert();
    }
}

/// Drives the contract through random sequences of user and owner actions and keeps the
/// books the invariants are checked against.
contract Handler is Test {
    Etherdisk public disk;
    address[] public users;
    address payable public treasury = payable(makeAddr("treasury"));
    address public eoaOwner = makeAddr("owner");
    Refuser public refuser = new Refuser();

    uint256 public paid; // sum of all mint payments
    uint256 public toOwners; // reached the owner directly
    uint256 public withdrawn; // taken out with withdraw()
    uint256 public minted;
    mapping(uint256 => uint32) public capacityAtMint;

    constructor(Etherdisk d) {
        disk = d;
        for (uint256 i; i < 4; i++) {
            users.push(makeAddr(string.concat("user", vm.toString(i))));
            vm.deal(users[i], 1000 ether);
        }
    }

    function _owner() private view returns (address) {
        return disk.owner();
    }

    function mint(uint256 who, uint256 tierSeed) external {
        uint256 tierId = tierSeed % disk.tierCount();
        Etherdisk.Tier memory tier = disk.getTier(tierId);
        if (!tier.active) return;
        address user = users[who % users.length];
        address owner = _owner();
        uint256 ownerBefore = owner.balance;
        vm.prank(user);
        uint256 id = disk.mint{value: tier.price}(tierId);
        paid += tier.price;
        toOwners += owner.balance - ownerBefore;
        minted++;
        capacityAtMint[id] = tier.capacityGb;
    }

    function transfer(uint256 to, uint256 idSeed) external {
        if (minted == 0) return;
        uint256 id = idSeed % minted + 1;
        address holder = disk.ownerOf(id);
        vm.prank(holder);
        disk.transferFrom(holder, users[to % users.length], id);
    }

    function setPrice(uint256 tierSeed, uint256 price) external {
        uint256 tierId = tierSeed % disk.tierCount();
        vm.prank(_owner());
        disk.setTierPrice(tierId, bound(price, 0, 10 ether));
    }

    function toggleTier(uint256 tierSeed, bool active) external {
        uint256 tierId = tierSeed % disk.tierCount();
        vm.prank(_owner());
        disk.setTierActive(tierId, active);
    }

    function addTier(uint32 capacityGb, uint256 price, uint24 color) external {
        if (disk.tierCount() >= 12) return;
        vm.prank(_owner());
        disk.addTier(uint32(bound(capacityGb, 1, 4096)), bound(price, 0, 10 ether), color);
    }

    function withdraw() external {
        uint256 held = address(disk).balance;
        vm.prank(_owner());
        disk.withdraw(treasury);
        withdrawn += held;
    }

    /// Hands the contract to an owner that refuses ETH, or back to a normal wallet.
    function switchOwner(bool toRefuser) external {
        address next = toRefuser ? address(refuser) : eoaOwner;
        if (next == _owner()) return;
        vm.prank(_owner());
        disk.transferOwnership(next);
        vm.prank(next);
        disk.acceptOwnership();
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 150
contract EtherdiskInvariantTest is Test {
    Etherdisk disk;
    Handler handler;

    function setUp() public {
        disk = TestTiers.deploy(makeAddr("owner"));
        handler = new Handler(disk);
        targetContract(address(handler));
    }

    /// Every wei paid went to an owner, was withdrawn, or is still in the contract.
    function invariant_moneyIsConserved() public view {
        assertEq(handler.paid(), handler.toOwners() + handler.withdrawn() + address(disk).balance);
    }

    /// A drive's capacity is fixed when it is minted, whatever happens to tiers later.
    function invariant_capacityNeverChanges() public view {
        uint256 n = handler.minted();
        for (uint256 id = 1; id <= n; id++) {
            assertEq(disk.capacityOf(id), handler.capacityAtMint(id));
        }
    }

    /// Supply matches the mints and the balances; every id 1..n exists and is held.
    function invariant_supplyAddsUp() public view {
        uint256 n = handler.minted();
        assertEq(disk.totalSupply(), n);
        uint256 held;
        for (uint256 i; i < 4; i++) {
            held += disk.balanceOf(handler.users(i));
        }
        assertEq(held, n);
        for (uint256 id = 1; id <= n; id++) {
            assertTrue(disk.ownerOf(id) != address(0));
        }
    }
}
