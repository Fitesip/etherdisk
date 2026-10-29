// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Builds a drive token's metadata (tokenURI). Etherdisk asks the renderer its
///         owner set, so the picture and texts can be fixed without moving the tokens,
///         until the owner freezes them.
interface IEtherdiskRenderer {
    /// @param rgb  the color of the drive's tier, 0xrrggbb
    /// @param version  the Etherdisk version of the token's contract (1 for the first)
    /// @param movedTo  the next version if the drive has moved there (the token is a legacy
    ///        one, holding no storage), else address(0)
    function tokenURI(uint256 tokenId, uint32 capacityGb, uint24 rgb, uint256 version, address movedTo)
        external
        view
        returns (string memory);
}
