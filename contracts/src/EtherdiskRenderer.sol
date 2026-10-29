// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {EtherdiskArt} from "./EtherdiskArt.sol";
import {IEtherdiskRenderer} from "./IEtherdiskRenderer.sol";

/// @title EtherdiskRenderer
/// @notice Fully on-chain metadata of a drive token: its name, a description, a link to the
///         drive's public page (whether it is for sale with its files), the capacity and an
///         SVG picture in the tier's color. The old token of a drive that moved to a later
///         version is a "Legacy" one: gray, stamped with its version, holding no storage.
contract EtherdiskRenderer is IEtherdiskRenderer {
    using Strings for uint256;

    /// The drive's page is `pageBase` followed by the token id, e.g. "https://etherdisk.app/nft/".
    string public pageBase;

    constructor(string memory pageBase_) {
        pageBase = pageBase_;
    }

    function tokenURI(uint256 tokenId, uint32 capacityGb, uint24 rgb, uint256 version, address movedTo)
        external
        view
        returns (string memory)
    {
        return string.concat(
            "data:application/json;base64,", Base64.encode(bytes(json(tokenId, capacityGb, rgb, version, movedTo)))
        );
    }

    /// @notice The metadata JSON itself (tokenURI is it as a data URI).
    function json(uint256 tokenId, uint32 capacityGb, uint24 rgb, uint256 version, address movedTo)
        public
        view
        returns (string memory)
    {
        string memory id = tokenId.toString();
        string memory label = EtherdiskArt.capacityLabel(capacityGb);
        bool moved = movedTo != address(0);
        return string.concat(
            '{"name":"Etherdisk #',
            id,
            moved ? string.concat(unicode" · Legacy v", version.toString()) : "",
            '","description":"',
            moved ? _legacyText(label, version, movedTo) : _text(label),
            '","external_url":"',
            pageBase,
            id,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(EtherdiskArt.svg(tokenId, capacityGb, rgb, moved ? version : 0))),
            '","attributes":[{"trait_type":"Capacity","value":"',
            label,
            moved
                ? string.concat(
                    '"},{"trait_type":"Status","value":"Legacy"},{"trait_type":"Version","value":"v', version.toString()
                )
                : "",
            '"}]}'
        );
    }

    function _text(string memory label) private pure returns (string memory) {
        return string.concat(
            label,
            " of end-to-end encrypted cloud storage, owned as this NFT. Files are encrypted on the owner's device; ",
            "a buyer gets them only if the seller hands over the drive key. Check the drive's page before buying."
        );
    }

    function _legacyText(string memory label, uint256 version, address movedTo) private pure returns (string memory) {
        return string.concat(
            "Legacy token of Etherdisk v",
            version.toString(),
            ". This ",
            label,
            " drive has moved to Etherdisk v",
            (version + 1).toString(),
            " (",
            Strings.toHexString(movedTo),
            "), where it keeps its number, capacity and files. This token holds no storage and no files: ",
            "don't buy it as a drive."
        );
    }
}
