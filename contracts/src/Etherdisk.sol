// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

import {IEtherdiskRenderer} from "./IEtherdiskRenderer.sol";
import {EtherdiskMigration, IEtherdiskLegacy} from "./migration/EtherdiskMigration.sol";

/// @title Etherdisk
/// @notice Each token is an encrypted storage drive. The token's tier defines its capacity in GB.
///         The contract only proves ownership and capacity; files and keys live off-chain.
///         Transfers are plain ERC-721 transfers (no restrictions). There is no on-chain
///         per-owner enumeration (it made every mint and transfer cost more): lists of a
///         wallet's drives come from `Transfer` events, and access always checks `ownerOf`.
///         Mint payments go straight to the contract owner; if that transfer fails they stay
///         here for `withdraw`. Ownership moves in two steps (the new owner accepts), and it
///         can't be renounced: a typo or a slip can't leave the contract without an owner.
///         Metadata comes from a renderer the owner can replace (or recolor a tier) until
///         `freezeMetadata`; marketplaces are told to refresh (ERC-4906). Royalties: ERC-2981.
///         Drives of the previous contract move here with the same id and capacity (their data
///         stays): see EtherdiskMigration; the legacy token goes to the owner.
contract Etherdisk is ERC721, ERC2981, IERC4906, Ownable2Step, EtherdiskMigration {
    struct Tier {
        uint32 capacityGb; // immutable after creation: existing tokens must never change size
        uint24 color; // 0xrrggbb: the drive's picture and the site's color for the tier
        bool active; // whether new tokens of this tier can be minted
        bool hidden; // left out of the site's list of tiers (its drives stay as they are)
        uint256 price; // wei, can be updated for future mints
    }

    Tier[] private _tiers;
    mapping(uint256 tokenId => uint256 tierId) private _tokenTier;
    uint256 private _nextTokenId = 1;
    /// Wallets the owner trusts to open and close sales of a tier (e.g. moderators), so a
    /// multisig owner doesn't have to sign every such switch. They can't change prices.
    mapping(address => bool) public isOperator;
    /// Builds `tokenURI`; replaceable by the owner until the metadata is frozen.
    IEtherdiskRenderer public renderer;
    /// Once set, neither the renderer nor a tier's color can change.
    bool public metadataFrozen;

    /// Enough for an EOA or a multisig's `receive`; bounds what an owner contract can cost minters.
    uint256 private constant PAYOUT_GAS = 50_000;
    /// Royalties are capped at 10% (in basis points).
    uint96 public constant MAX_ROYALTY_BPS = 1000;

    event TierAdded(uint256 indexed tierId, uint32 capacityGb, uint256 price, uint24 color);
    event TierPriceUpdated(uint256 indexed tierId, uint256 price);
    event TierActiveUpdated(uint256 indexed tierId, bool active);
    event TierHiddenUpdated(uint256 indexed tierId, bool hidden);
    event TierColorUpdated(uint256 indexed tierId, uint24 color);
    event RendererSet(address indexed renderer);
    event MetadataFrozen();
    event RoyaltySet(address indexed receiver, uint96 bps);
    event OperatorSet(address indexed operator, bool enabled);
    event DriveMinted(uint256 indexed tokenId, address indexed owner, uint256 indexed tierId);
    /// The owner couldn't take a mint payment (e.g. a contract without `receive`): kept for `withdraw`.
    event PaymentHeld(address indexed owner, uint256 amount);

    error InvalidTier();
    error TierInactive();
    error WrongPayment();
    error ZeroCapacity();
    error WithdrawFailed();
    error RenounceDisabled();
    error ZeroAddress();
    error NotOperator();
    error TiersMismatch();
    error MetadataIsFrozen();
    error RoyaltyTooHigh();
    error NoTierForCapacity(uint32 capacityGb);

    /// @param renderer_  builds the tokens' metadata (see IEtherdiskRenderer)
    /// @param capacitiesGb, prices, active, colors  the initial tiers (same length); an
    ///        inactive tier is listed but can't be bought yet ("coming soon")
    /// @param royaltyBps  royalty on resales for the owner, in basis points (500 = 5%)
    /// @param legacy_  the previous Etherdisk contract whose drives can move here (its sales
    ///        must be closed for good); address(0) for none
    constructor(
        address initialOwner,
        IEtherdiskRenderer renderer_,
        uint32[] memory capacitiesGb,
        uint256[] memory prices,
        bool[] memory active,
        uint24[] memory colors,
        uint96 royaltyBps,
        IEtherdiskLegacy legacy_
    ) ERC721("Etherdisk", "DISK") Ownable(initialOwner) EtherdiskMigration(legacy_) {
        uint256 n = capacitiesGb.length;
        if (prices.length != n || active.length != n || colors.length != n) revert TiersMismatch();
        _setRenderer(renderer_);
        _setRoyalty(initialOwner, royaltyBps);
        for (uint256 i; i < n; i++) {
            _addTier(capacitiesGb[i], prices[i], colors[i], active[i]);
        }
    }

    modifier onlyOperatorOrOwner() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------------- mint

    function mint(uint256 tierId) external payable returns (uint256 tokenId) {
        Tier storage tier = _getTier(tierId);
        if (!tier.active) revert TierInactive();
        if (msg.value != tier.price) revert WrongPayment();
        _requireCanMint();

        // After every id of the previous contract, so its drives can move here with theirs.
        tokenId = _nextNewTokenId(_nextTokenId);
        _nextTokenId = tokenId + 1;
        _tokenTier[tokenId] = tierId;
        // Logged before the receiver's callback, so a re-entering minter can't reorder events.
        emit DriveMinted(tokenId, msg.sender, tierId);
        _safeMint(msg.sender, tokenId);
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

    /// @notice The highest drive id handed out, here or by the previous contracts (ids run
    ///         from 1 to this; tokens are never burned). The next version numbers after it.
    function totalSupply() external view returns (uint256) {
        return _nextNewTokenId(_nextTokenId) - 1;
    }

    /// @notice On-chain metadata from the renderer: name, capacity, the drive's page, an SVG image.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Tier storage tier = _tiers[_tokenTier[tokenId]];
        return renderer.tokenURI(tokenId, tier.capacityGb, tier.color);
    }

    /// ERC-721, ERC-2981 and ERC-4906 (metadata update events).
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981, IERC165) returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------- admin

    /// A new tier: not on sale until `setTierActive`, shown unless hidden.
    function addTier(uint32 capacityGb, uint256 price, uint24 color) external onlyOwner returns (uint256) {
        return _addTier(capacityGb, price, color, false);
    }

    function setTierPrice(uint256 tierId, uint256 price) external onlyOwner {
        _getTier(tierId).price = price;
        emit TierPriceUpdated(tierId, price);
    }

    /// Opens or closes sales of a tier; the owner or an operator.
    function setTierActive(uint256 tierId, bool active) external onlyOperatorOrOwner {
        _getTier(tierId).active = active;
        emit TierActiveUpdated(tierId, active);
    }

    /// Leaves a tier out of the site's list, or brings it back; the owner or an operator.
    /// Its drives are not affected.
    function setTierHidden(uint256 tierId, bool hidden) external onlyOperatorOrOwner {
        _getTier(tierId).hidden = hidden;
        emit TierHiddenUpdated(tierId, hidden);
    }

    /// Recolors a tier: its drives' pictures change, so marketplaces are told to refresh.
    function setTierColor(uint256 tierId, uint24 color) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _getTier(tierId).color = color;
        emit TierColorUpdated(tierId, color);
        _refreshAll();
    }

    /// Replaces the metadata renderer; marketplaces are told to refresh every token.
    function setRenderer(IEtherdiskRenderer renderer_) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _setRenderer(renderer_);
        _refreshAll();
    }

    /// Makes the metadata final: no other renderer, no other tier colors. Can't be undone.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// Royalty on resales (ERC-2981), up to `MAX_ROYALTY_BPS`.
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setRoyalty(receiver, bps);
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        // forge-lint: disable-next-line(missing-events-access-control) OperatorSet follows
        isOperator[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    /// Disabled: without an owner, prices could never change and held payments would be stuck.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// Stops minting for good, before the next version takes this one's drives (its ids must
    /// be final). Irreversible: drives keep working and can still be transferred and moved.
    function closeSales() external onlyOwner {
        _closeSales();
    }

    /// Opens moves from the previous contract, once the server follows it (docs/MIGRATION.md).
    function setMigrationOpen(bool open) external onlyOwner {
        _setMigrationOpen(open);
    }

    /// Completes the move of a legacy drive sent here with a plain `transferFrom` (stuck).
    function rescueMigration(uint256 tokenId, address holder) external onlyOwner {
        _rescueMigration(tokenId, holder);
    }

    function withdraw(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    // ---------------------------------------------------------------- internal

    /// Forwards a mint payment to the owner. Never reverts: a failed transfer leaves the
    /// payment in the contract for `withdraw`.
    function _payOwner(uint256 amount) private {
        address payable to = payable(owner());
        if (amount == 0) return;
        // The destination is the owner, not the caller. Return data is not copied, so the
        // receiver can't make minting expensive with a huge answer.
        bool ok;
        assembly ("memory-safe") {
            ok := call(PAYOUT_GAS, to, amount, 0, 0, 0, 0)
        }
        // The event can only follow the transfer's result.
        // forge-lint: disable-next-line(reentrancy-events)
        if (!ok) emit PaymentHeld(to, amount); // slither-disable-line reentrancy-events
    }

    function _addTier(uint32 capacityGb, uint256 price, uint24 color, bool active) private returns (uint256 tierId) {
        // forge-lint: disable-next-line(require-revert-in-loop) checks the constructor's tiers
        if (capacityGb == 0) revert ZeroCapacity();
        tierId = _tiers.length;
        _tiers.push(Tier({capacityGb: capacityGb, color: color, active: active, hidden: false, price: price}));
        emit TierAdded(tierId, capacityGb, price, color);
        emit TierActiveUpdated(tierId, active);
    }

    function _setRenderer(IEtherdiskRenderer renderer_) private {
        if (address(renderer_) == address(0)) revert ZeroAddress();
        renderer = renderer_;
        emit RendererSet(address(renderer_));
    }

    function _setRoyalty(address receiver, uint96 bps) private {
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _setDefaultRoyalty(receiver, bps);
        emit RoyaltySet(receiver, bps);
    }

    /// A moved drive gets the tier of its capacity here (its color and picture). Without one,
    /// the owner adds it first (it can stay hidden and off sale).
    function _mintMigrated(address holder, uint256 tokenId, uint32 capacityGb) internal override {
        uint256 n = _tiers.length;
        uint256 tierId = n;
        for (uint256 i; i < n; i++) {
            if (_tiers[i].capacityGb == capacityGb) {
                tierId = i;
                break;
            }
        }
        if (tierId == n) revert NoTierForCapacity(capacityGb);
        _tokenTier[tokenId] = tierId;
        _mint(holder, tokenId);
    }

    function _existsHere(uint256 tokenId) internal view override returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    function _migrationReceiver() internal view override returns (address) {
        return owner();
    }

    /// ERC-4906: every token's metadata may have changed.
    function _refreshAll() private {
        if (_nextTokenId > 1) emit BatchMetadataUpdate(1, _nextTokenId - 1);
    }

    function _getTier(uint256 tierId) private view returns (Tier storage) {
        if (tierId >= _tiers.length) revert InvalidTier();
        return _tiers[tierId];
    }
}
