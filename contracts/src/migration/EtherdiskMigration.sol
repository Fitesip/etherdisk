// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice What a successor needs from the deployed Etherdisk (it is immutable and stays as is).
interface IEtherdiskLegacy is IERC721 {
    function capacityOf(uint256 tokenId) external view returns (uint32);
    function totalSupply() external view returns (uint256);
}

/// @title EtherdiskMigration
/// @notice For a future Etherdisk contract: holders swap a drive of the current (legacy)
///         contract for one here with the SAME token id and capacity, in one transaction:
///         `legacy.safeTransferFrom(holder, address(successor), tokenId)`. The legacy token
///         stays locked here for good (ERC-721 has no burn), so it can't be swapped twice. The
///         server keys files and keys by token id, so the drive keeps all its data.
///
///         A successor inherits this next to its ERC-721 and implements `_mintMigrated`.
///         Swaps are closed until the owner opens them (`_setMigrationOpen`): first the
///         server must follow both contracts (docs/MIGRATION.md), or it would take a swap
///         for a sale. New drives of the successor must take ids from `_nextNewTokenId`,
///         after every legacy id, and the legacy contract's sales must be closed for good.
abstract contract EtherdiskMigration is IERC721Receiver {
    IEtherdiskLegacy public immutable legacy;
    bool public migrationOpen;

    event MigrationOpened(bool open);
    event DriveMigrated(uint256 indexed tokenId, address indexed holder, uint32 capacityGb);

    error NotLegacyToken();
    error MigrationClosed();
    error NotStuck();

    constructor(IEtherdiskLegacy legacy_) {
        legacy = legacy_;
    }

    /// @notice The swap: called by the legacy contract when a holder sends it a drive with
    ///         `safeTransferFrom`. Mints the same id and capacity to the sender's holder.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(legacy)) revert NotLegacyToken();
        if (!migrationOpen) revert MigrationClosed();
        // The legacy contract has already moved the token here; `from` held it.
        _migrate(from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice The same swap for wallets that can't call `safeTransferFrom` directly: the
    ///         holder approves this contract for the drive (or all drives), then calls this.
    ///         Only the holder: nobody else can start a swap of their drive.
    function migrate(uint256 tokenId) external {
        if (!migrationOpen) revert MigrationClosed();
        // transferFrom (not safe): no callback, the mint happens right here. Reverts unless
        // the caller holds the drive.
        legacy.transferFrom(msg.sender, address(this), tokenId);
        _migrate(msg.sender, tokenId);
    }

    /// Mints the successor's drive. Reverts (and so undoes the whole swap, the legacy token
    /// goes back) if the id is already taken here.
    function _migrate(address holder, uint256 tokenId) private {
        uint32 capacityGb = legacy.capacityOf(tokenId);
        // Logged before the mint, like the legacy contract's DriveMinted. The calls before it go
        // only to the legacy contract (trusted, ours), which can't re-enter with other logs.
        // forge-lint: disable-next-line(reentrancy-events)
        emit DriveMigrated(tokenId, holder, capacityGb);
        _mintMigrated(holder, tokenId, capacityGb);
    }

    /// @dev Mint `tokenId` with `capacityGb` to `holder` (use `_mint`, not `_safeMint`: a holder
    ///      contract already took the legacy token, and no callback can re-enter the swap).
    function _mintMigrated(address holder, uint256 tokenId, uint32 capacityGb) internal virtual;

    /// @dev Whether `tokenId` exists in the successor (its `_ownerOf(tokenId) != address(0)`).
    function _existsHere(uint256 tokenId) internal view virtual returns (bool);

    /// @dev Owner only in the successor: open after the server follows both contracts.
    function _setMigrationOpen(bool open) internal {
        migrationOpen = open;
        emit MigrationOpened(open);
    }

    /// @dev Owner only in the successor: a legacy drive sent here with plain `transferFrom`
    ///      (no callback, so no swap) is locked without a drive in return. The owner mints it
    ///      to `holder`, the wallet that sent it (from the legacy `Transfer` event).
    function _rescueMigration(uint256 tokenId, address holder) internal {
        if (legacy.ownerOf(tokenId) != address(this) || _existsHere(tokenId)) revert NotStuck();
        _migrate(holder, tokenId);
    }

    /// @dev The id for the successor's next new drive: never one a legacy drive has.
    function _nextNewTokenId(uint256 next) internal view returns (uint256) {
        uint256 afterLegacy = legacy.totalSupply() + 1;
        return next > afterLegacy ? next : afterLegacy;
    }
}
