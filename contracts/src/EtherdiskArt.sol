// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title EtherdiskArt
/// @notice On-chain metadata and SVG image of a drive token, so wallets and marketplaces
///         show the drive (capacity, number) without any off-chain server.
library EtherdiskArt {
    using Strings for uint256;

    /// @dev Accent color: one per power of two, so six consecutive sizes (64 GB … 2 TB on
    ///      mainnet, 1 … 32 GB on a testnet) all differ.
    function _color(uint32 capacityGb) private pure returns (string memory) {
        uint256 i = _log2(capacityGb) % 6;
        if (i == 0) return "#6366f1";
        if (i == 1) return "#10b981";
        if (i == 2) return "#f59e0b";
        if (i == 3) return "#ec4899";
        if (i == 4) return "#0ea5e9";
        return "#a855f7";
    }

    function _log2(uint32 x) private pure returns (uint256 n) {
        while (x > 1) {
            x >>= 1;
            n++;
        }
    }

    /// @dev Tracks on the platter: more for bigger drives (4 … 10).
    function _rings(uint32 capacityGb) private pure returns (uint256) {
        uint256 n = _log2(capacityGb);
        return n < 6 ? 4 : n > 12 ? 10 : n - 2;
    }

    /// @dev "512 GB", or "1 TB" from 1024 GB up (whole terabytes only).
    function _capacityLabel(uint32 capacityGb) private pure returns (string memory) {
        if (capacityGb >= 1024 && capacityGb % 1024 == 0) {
            return string.concat((uint256(capacityGb) / 1024).toString(), " TB");
        }
        return string.concat(uint256(capacityGb).toString(), " GB");
    }

    /// @notice An opened hard drive: the name and number on a strip in the tier color, the
    ///         capacity on the platter's hub.
    function svg(uint256 tokenId, uint32 capacityGb) internal pure returns (string memory) {
        string memory c = _color(capacityGb);
        return string.concat(_chassis(c, tokenId.toString()), _platter(c, capacityGb), _arm(c), "</svg>");
    }

    function _chassis(string memory c, string memory id) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="ui-sans-serif,system-ui,sans-serif">',
            '<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2a30"/><stop offset="1" stop-color="#141417"/></linearGradient>',
            '<radialGradient id="p" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="#3a3a42"/><stop offset="1" stop-color="#16161a"/></radialGradient></defs>',
            '<rect width="400" height="400" fill="#0b0b0d"/><rect x="70" y="28" width="260" height="344" rx="18" fill="url(#m)" stroke="#fff" stroke-opacity=".1"/>',
            '<path d="M88 28h224a18 18 0 0 1 18 18v22H70V46a18 18 0 0 1 18-18z" fill="',
            c,
            '"/><text x="92" y="54" fill="#fff" font-size="12" font-weight="700" letter-spacing="3">ETHERDISK</text>',
            '<text x="308" y="54" text-anchor="end" fill="#fff" font-size="12" font-family="ui-monospace,monospace">#',
            id,
            "</text>"
        );
    }

    function _platter(string memory c, uint32 capacityGb) private pure returns (string memory out) {
        out = string.concat('<circle cx="200" cy="220" r="118" fill="url(#p)" stroke="', c, '" stroke-width="2"/>');
        uint256 n = _rings(capacityGb);
        for (uint256 i; i < n; i++) {
            bool accent = i % 3 == 0;
            out = string.concat(
                out,
                '<circle cx="200" cy="220" r="',
                (108 - 7 * i).toString(),
                '" fill="none" stroke="',
                accent ? c : "#fff",
                accent ? '" stroke-opacity=".35"/>' : '" stroke-opacity=".07"/>'
            );
        }
        string memory label = _capacityLabel(capacityGb);
        out = string.concat(
            out,
            '<circle cx="200" cy="220" r="40" fill="#0b0b0d" stroke="',
            c,
            '" stroke-width="3"/><text x="200" y="227" text-anchor="middle" fill="#fff" font-size="',
            bytes(label).length > 5 ? "17" : "19",
            '" font-weight="800">',
            label,
            "</text>"
        );
    }

    /// @dev The read arm and two screws.
    function _arm(string memory c) private pure returns (string memory) {
        return string.concat(
            '<path d="M302 350L262 268" stroke="#c9ccd3" stroke-width="7" stroke-linecap="round"/>',
            '<circle cx="302" cy="350" r="13" fill="#c9ccd3"/><circle cx="262" cy="268" r="4" fill="',
            c,
            '"/><circle cx="88" cy="354" r="5" fill="#3a3a42" stroke="#0b0b0d"/><circle cx="312" cy="86" r="5" fill="#3a3a42" stroke="#0b0b0d"/>'
        );
    }

    /// @notice ERC-721 metadata JSON as a data URI.
    function tokenURI(uint256 tokenId, uint32 capacityGb, uint256 tierId) internal pure returns (string memory) {
        string memory label = _capacityLabel(capacityGb);
        string memory head = string.concat(
            '{"name":"Etherdisk #',
            tokenId.toString(),
            '","description":"End-to-end encrypted cloud storage owned as an NFT. Capacity: ',
            label,
            '. Files are encrypted in the browser and travel with the token.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg(tokenId, capacityGb)))
        );
        string memory attrs = string.concat(
            '","attributes":[{"trait_type":"Capacity","value":"',
            label,
            '"},{"trait_type":"Capacity (GB)","display_type":"number","value":',
            uint256(capacityGb).toString(),
            '},{"trait_type":"Tier","value":',
            tierId.toString(),
            "}]}"
        );
        string memory json = string.concat(head, attrs);
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
