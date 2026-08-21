// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title VaultArt
/// @notice On-chain metadata and SVG image of a vault token, so wallets and marketplaces
///         show the drive (capacity, number) without any off-chain server.
library VaultArt {
    using Strings for uint256;

    /// @dev Accent color per capacity; larger tiers cycle through the rest.
    function _color(uint32 capacityGb) private pure returns (string memory) {
        if (capacityGb <= 1) return "#6366f1";
        if (capacityGb <= 2) return "#10b981";
        if (capacityGb <= 4) return "#f59e0b";
        if (capacityGb <= 16) return "#ec4899";
        if (capacityGb <= 128) return "#0ea5e9";
        return "#a855f7";
    }

    /// @dev "512 GB", or "1 TB" from 1024 GB up (whole terabytes only).
    function _capacityLabel(uint32 capacityGb) private pure returns (string memory) {
        if (capacityGb >= 1024 && capacityGb % 1024 == 0) {
            return string.concat((uint256(capacityGb) / 1024).toString(), " TB");
        }
        return string.concat(uint256(capacityGb).toString(), " GB");
    }

    function svg(uint256 tokenId, uint32 capacityGb) internal pure returns (string memory) {
        string memory c = _color(capacityGb);
        string memory id = tokenId.toString();
        string memory background = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="ui-sans-serif,system-ui,sans-serif">',
            '<defs><radialGradient id="g" cx="80%" cy="0%" r="90%"><stop offset="0" stop-color="',
            c,
            '" stop-opacity=".55"/><stop offset="1" stop-color="#0b0b0d" stop-opacity="0"/></radialGradient>',
            '<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff" fill-opacity=".07"/></pattern></defs>',
            '<rect width="400" height="400" fill="#0b0b0d"/><rect width="400" height="400" fill="url(#d)"/><rect width="400" height="400" fill="url(#g)"/>'
        );
        return string.concat(background, _card(c, id, capacityGb), "</svg>");
    }

    function _card(string memory c, string memory id, uint32 capacityGb) private pure returns (string memory) {
        return string.concat(_header(c, id), _footer(c, capacityGb));
    }

    /// @dev Card frame, drive icon, number.
    function _header(string memory c, string memory id) private pure returns (string memory) {
        string memory frame = string.concat(
            '<rect x="40" y="96" width="320" height="208" rx="24" fill="#141417" stroke="',
            c,
            '" stroke-opacity=".6" stroke-width="2"/><rect x="68" y="124" width="56" height="56" rx="14" fill="',
            c,
            '"/><rect x="80" y="146" width="32" height="14" rx="4" fill="none" stroke="#fff" stroke-width="2.5"/>',
            '<circle cx="104" cy="153" r="2" fill="#fff"/>'
        );
        return string.concat(
            frame,
            '<text x="140" y="148" fill="#ececf1" font-size="20" font-weight="600">Drive #',
            id,
            '</text><text x="140" y="172" fill="#8e8e99" font-size="13">NFT Vault</text>'
        );
    }

    /// @dev Capacity and the "encrypted" caption with a lock.
    function _footer(string memory c, uint32 capacityGb) private pure returns (string memory) {
        string memory capacity = string.concat(
            '<text x="68" y="252" fill="#ececf1" font-size="44" font-weight="700" letter-spacing="-1">',
            _capacityLabel(capacityGb),
            "</text>"
        );
        return string.concat(
            capacity,
            '<rect x="68" y="270" width="10" height="8" rx="2" fill="',
            c,
            '"/><path d="M70 270v-3a3 3 0 0 1 6 0v3" fill="none" stroke="',
            c,
            '" stroke-width="1.6"/><text x="86" y="278" fill="#8e8e99" font-size="12">End-to-end encrypted storage</text>'
        );
    }

    /// @notice ERC-721 metadata JSON as a data URI.
    function tokenURI(uint256 tokenId, uint32 capacityGb, uint256 tierId) internal pure returns (string memory) {
        string memory label = _capacityLabel(capacityGb);
        string memory head = string.concat(
            '{"name":"Vault Drive #',
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
