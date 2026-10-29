// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice What a successor needs from the previous Etherdisk contract. Every Etherdisk
///         version has these, so each one can be the legacy of the next.
interface IEtherdiskLegacy is IERC721 {
    function capacityOf(uint256 tokenId) external view returns (uint32);
    /// The highest token id it has handed out (ids run from 1 to this).
    function totalSupply() external view returns (uint256);
    /// Its place in the chain of versions: 1 for the first.
    function version() external view returns (uint256);
    /// The version before it (address(0) for the first).
    function legacy() external view returns (IEtherdiskLegacy);
    /// The version after it, once it has handed over (it mints no more from then on).
    function successor() external view returns (address);
    /// Who last sent `tokenId` to the successor: the holder a move without the callback is for.
    function sentToSuccessorBy(uint256 tokenId) external view returns (address);
}

/// @title EtherdiskMigration
/// @notice Moves drives from the previous Etherdisk contract (`legacy`) to this one: the holder
///         gets a drive here with the SAME token id and capacity, so the server, which keys
///         files and keys by token id, keeps all of its data. The holder pays only the
///         transaction's network fee; the drive was bought already.
///
///         One transaction: `legacy.safeTransferFrom(holder, address(this), tokenId)`. This
///         contract passes the legacy token on to `_migrationReceiver()` (the owner, a Safe)
///         and mints the same id to the holder. The legacy token always goes through here, so
///         the server tells a move (a transfer to or from this contract) from a sale. An id
///         moves once: minting it again reverts, and so does the whole transaction.
///
///         Each version inherits this with the previous one as `legacy`, so drives move along
///         the chain one version at a time, whenever their holders like. New drives take ids
///         after every legacy id (`_nextNewTokenId`), and `totalSupply` counts those too, so the
///         next version numbers after both. That holds only while the legacy contract mints no
///         more: this contract neither mints nor takes moves until the legacy one has handed
///         over to it (`setSuccessor`, irreversible, which ends its sales), so no id is ever
///         handed out twice. A moved drive's old token shows as "Legacy" (its contract knows
///         the successor and asks it whether the drive is there).
///         Moves are closed until the owner opens them (`_setMigrationOpen`): the server must
///         follow the legacy contract first (docs/MIGRATION.md), or it would take a move for a sale.
abstract contract EtherdiskMigration is IERC721Receiver {
    /// The previous contract; address(0) for the first one (nothing to move).
    IEtherdiskLegacy public immutable legacy;
    /// 1 for the first contract, one more than `legacy`'s for each later one.
    uint256 public immutable version;
    bool public migrationOpen;
    /// The next version, which takes this one's drives; set once, and no more mints here.
    address public successor;
    /// Who last sent each token to the successor (a plain transfer gets no move by itself).
    mapping(uint256 tokenId => address holder) public sentToSuccessorBy;

    event MigrationOpened(bool open);
    event SuccessorSet(address indexed successor);
    event DriveMigrated(uint256 indexed tokenId, address indexed holder, uint32 capacityGb);

    error NotLegacyToken();
    error MigrationClosed();
    error NotStuck();
    error SalesClosedForGood();
    /// The previous version hasn't handed over to this one: its ids aren't final yet.
    error LegacyNotHandedOver();
    error SuccessorAlreadySet();
    /// Not a version whose `legacy` is this contract.
    error NotSuccessor();

    constructor(IEtherdiskLegacy legacy_) {
        legacy = legacy_;
        version = address(legacy_) == address(0) ? 1 : legacy_.version() + 1;
    }

    /// @notice The move: called by the legacy contract when a holder sends it a drive with
    ///         `safeTransferFrom`. Mints the same id and capacity to the holder.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(legacy) || address(legacy) == address(0)) revert NotLegacyToken();
        if (!migrationOpen) revert MigrationClosed();
        // The legacy contract has already moved the token here; `from` held it.
        _migrate(from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice The same move for wallets that can't call `safeTransferFrom` directly: the
    ///         holder approves this contract for the drive (or all drives), then calls this.
    ///         Only the holder: nobody else can move their drive.
    function migrate(uint256 tokenId) external {
        if (!migrationOpen) revert MigrationClosed();
        // transferFrom (not safe): no callback, the move happens right here. Reverts unless
        // the caller holds the drive.
        legacy.transferFrom(msg.sender, address(this), tokenId);
        _migrate(msg.sender, tokenId);
    }

    /// Passes the legacy token (held here) on to the receiver and mints the drive here. The
    /// mint reverts if the id is taken here (moved already), undoing the whole move.
    function _migrate(address holder, uint256 tokenId) private {
        uint32 capacityGb = legacy.capacityOf(tokenId);
        // Logged before the mint, like DriveMinted. The calls before it go only to the legacy
        // contract (trusted, ours), which can't re-enter with other logs.
        // forge-lint: disable-next-line(reentrancy-events)
        emit DriveMigrated(tokenId, holder, capacityGb);
        legacy.transferFrom(address(this), _migrationReceiver(), tokenId);
        _mintMigrated(holder, tokenId, capacityGb);
    }

    /// @dev Mint `tokenId` with `capacityGb` to `holder` (use `_mint`, not `_safeMint`: a holder
    ///      contract already gave up the legacy token, and no callback can re-enter the move).
    function _mintMigrated(address holder, uint256 tokenId, uint32 capacityGb) internal virtual;

    /// @dev Whether `tokenId` exists here (its `_ownerOf(tokenId) != address(0)`).
    function _existsHere(uint256 tokenId) internal view virtual returns (bool);

    /// @dev Where moved legacy tokens go: the contract owner (a Safe).
    function _migrationReceiver() internal view virtual returns (address);

    /// @dev Owner only: open after the server follows the legacy contract.
    function _setMigrationOpen(bool open) internal {
        if (open) _requireHandedOver();
        migrationOpen = open;
        emit MigrationOpened(open);
    }

    /// @dev Anyone: a legacy drive sent here with plain `transferFrom` (no callback, so no
    ///      move) is stuck without a drive in return. This completes the move for the wallet
    ///      that sent it, as the legacy contract recorded it.
    function _completeMigration(uint256 tokenId) internal {
        if (legacy.ownerOf(tokenId) != address(this) || _existsHere(tokenId)) revert NotStuck();
        _migrate(legacy.sentToSuccessorBy(tokenId), tokenId);
    }

    /// @dev Owner only, once: hands over to the next version (whose `legacy` must be this
    ///      contract). Sales here end for good, so its ids are final.
    function _setSuccessor(address next) internal {
        if (successor != address(0)) revert SuccessorAlreadySet();
        if (next == address(0) || address(IEtherdiskLegacy(next).legacy()) != address(this)) revert NotSuccessor();
        successor = next;
        emit SuccessorSet(next);
    }

    /// @dev On every transfer: one to the successor is a move (or its first half). Returns
    ///      whether it was, so the token's metadata (soon "Legacy") can be refreshed.
    function _noteSentToSuccessor(address from, address to, uint256 tokenId) internal returns (bool) {
        if (to == address(0) || to != successor) return false;
        sentToSuccessorBy[tokenId] = from;
        return true;
    }

    /// @dev The successor if the drive has moved there (its old token here is a legacy one).
    function _movedTo(uint256 tokenId) internal view returns (address) {
        if (successor == address(0)) return address(0);
        try IEtherdiskLegacy(successor).ownerOf(tokenId) returns (address) {
            return successor;
        } catch {
            return address(0);
        }
    }

    /// @dev Before a mint here: no successor yet, and the legacy version has handed over.
    function _requireCanMint() internal view {
        if (successor != address(0)) revert SalesClosedForGood();
        _requireHandedOver();
    }

    function _requireHandedOver() private view {
        if (address(legacy) != address(0) && legacy.successor() != address(this)) revert LegacyNotHandedOver();
    }

    /// @dev The id for the next new drive: never one a legacy drive has.
    function _nextNewTokenId(uint256 next) internal view returns (uint256) {
        if (address(legacy) == address(0)) return next;
        uint256 afterLegacy = legacy.totalSupply() + 1;
        return next > afterLegacy ? next : afterLegacy;
    }
}
