// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {EtherdiskArt} from "./EtherdiskArt.sol";

/// @title Etherdisk
/// @notice Each token is an encrypted storage drive. The token's tier defines its capacity in GB.
///         The contract only proves ownership and capacity; files and keys live off-chain.
///         Transfers are plain ERC-721 transfers (no restrictions).
///         Mint payments go straight to the contract owner; if that transfer fails they stay
///         here for `withdraw`. Ownership moves in two steps (the new owner accepts), and it
///         can't be renounced: a typo or a slip can't leave the contract without an owner.
contract Etherdisk is ERC721Enumerable, Ownable2Step {
    struct Tier {
        uint32 capacityGb; // immutable after creation: existing tokens must never change size
        uint256 price; // wei, can be updated for future mints
        bool active; // whether new tokens of this tier can be minted
    }

    Tier[] private _tiers;
    mapping(uint256 tokenId => uint256 tierId) private _tokenTier;
    uint256 private _nextTokenId = 1;

    /// Enough for an EOA or a multisig's `receive`; bounds what an owner contract can cost minters.
    uint256 private constant PAYOUT_GAS = 50_000;

    event TierAdded(uint256 indexed tierId, uint32 capacityGb, uint256 price);
    event TierPriceUpdated(uint256 indexed tierId, uint256 price);
    event TierActiveUpdated(uint256 indexed tierId, bool active);
    event DriveMinted(uint256 indexed tokenId, address indexed owner, uint256 indexed tierId);
    /// The owner couldn't take a mint payment (e.g. a contract without `receive`): kept for `withdraw`.
    event PaymentHeld(address indexed owner, uint256 amount);

    error InvalidTier();
    error TierInactive();
    error WrongPayment();
    error ZeroCapacity();
    error WithdrawFailed();
    error RenounceDisabled();

    constructor(address initialOwner) ERC721("Etherdisk", "DISK") Ownable(initialOwner) {
        // Test tiers. Larger tiers (8/16/32/64/128/512/1024 GB) are added later via addTier.
        _addTier(1, 0.0005 ether);
        _addTier(2, 0.00075 ether);
        _addTier(4, 0.001 ether);
    }

    // ---------------------------------------------------------------- mint

    function mint(uint256 tierId) external payable returns (uint256 tokenId) {
        Tier storage tier = _getTier(tierId);
        if (!tier.active) revert TierInactive();
        if (msg.value != tier.price) revert WrongPayment();

        tokenId = _nextTokenId++;
        _tokenTier[tokenId] = tierId;
        _safeMint(msg.sender, tokenId);
        emit DriveMinted(tokenId, msg.sender, tierId);
        _payOwner(msg.value);
    }

    // ---------------------------------------------------------------- views

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function getTier(uint256 tierId) external view returns (Tier memory) {
        return _getTier(tierId);
    }

    function tierOf(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _tokenTier[tokenId];
    }

    /// @notice Capacity of the drive in GB. Used by the backend to enforce quotas.
    function capacityOf(uint256 tokenId) external view returns (uint32) {
        _requireOwned(tokenId);
        return _tiers[_tokenTier[tokenId]].capacityGb;
    }

    /// @notice All tokens owned by `account` (for rendering them as separate disks).
    function tokensOfOwner(address account) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(account);
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = tokenOfOwnerByIndex(account, i);
        }
    }

    /// @notice Fully on-chain metadata: name, capacity attributes and an SVG image.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        uint256 tierId = _tokenTier[tokenId];
        return EtherdiskArt.tokenURI(tokenId, _tiers[tierId].capacityGb, tierId);
    }

    // ---------------------------------------------------------------- admin

    function addTier(uint32 capacityGb, uint256 price) external onlyOwner returns (uint256) {
        return _addTier(capacityGb, price);
    }

    function setTierPrice(uint256 tierId, uint256 price) external onlyOwner {
        _getTier(tierId).price = price;
        emit TierPriceUpdated(tierId, price);
    }

    function setTierActive(uint256 tierId, bool active) external onlyOwner {
        _getTier(tierId).active = active;
        emit TierActiveUpdated(tierId, active);
    }

    /// Disabled: without an owner, prices could never change and held payments would be stuck.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function withdraw(address payable to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    // ---------------------------------------------------------------- internal

    /// Forwards a mint payment to the owner. Never reverts: a failed transfer leaves the
    /// payment in the contract for `withdraw`.
    function _payOwner(uint256 amount) private {
        address payable to = payable(owner());
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) emit PaymentHeld(to, amount);
    }

    function _addTier(uint32 capacityGb, uint256 price) private returns (uint256 tierId) {
        if (capacityGb == 0) revert ZeroCapacity();
        tierId = _tiers.length;
        _tiers.push(Tier(capacityGb, price, true));
        emit TierAdded(tierId, capacityGb, price);
    }

    function _getTier(uint256 tierId) private view returns (Tier storage) {
        if (tierId >= _tiers.length) revert InvalidTier();
        return _tiers[tierId];
    }

    // ERC721Enumerable requires these overrides (OpenZeppelin v5).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
