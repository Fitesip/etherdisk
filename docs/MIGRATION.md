# Moving to a new contract

The Etherdisk contract is immutable. If a new one is ever needed (new features, a fix), drives move to it **without losing data**: an owner swaps the old NFT for a new one with **the same number and capacity** in one transaction. Files, the key, the recovery key, labels and links are bound to the drive's number, so they stay where they are; nothing needs to be re-encrypted.

The current contract needs nothing for this: the new contract uses the old one's plain ERC-721 transfers, `capacityOf`, `totalSupply` and `setTierActive`.

## How the swap works

The new contract inherits `contracts/src/migration/EtherdiskMigration.sol` (next to its own ERC-721) and implements `_mintMigrated` and `_existsHere`. An example: `Successor` in `contracts/test/EtherdiskMigration.t.sol`.

- **A swap in one transaction:** `legacy.safeTransferFrom(owner, <new contract>, tokenId)`. The new contract receives the old token and at once mints the owner a drive with the same number and capacity (event `DriveMigrated`). The old token stays in the new contract for good, so a second swap is impossible.
- **For wallets without `safeTransferFrom`:** `legacy.approve(<new contract>, tokenId)`, then `migrate(tokenId)`.
- **Old contract drives only:** other NFTs are rejected (`NotLegacyToken`).
- **Closed until the owner opens it** (`_setMigrationOpen`): the server has to know about both contracts first.
- **New drives' numbers** come from `_nextNewTokenId`: after every number of the old contract. If a number is already taken, the whole swap reverts and the owner keeps the old drive.
- **Sent with a plain `transferFrom`** (no swap): the drive is stuck in the new contract. The contract owner (the Safe) releases it to the sender: `_rescueMigration(tokenId, sender)` (the sender is in the old contract's `Transfer` event). Until released, the drive opens for nobody.

Tests: `forge test --match-contract EtherdiskMigrationTest` (the swap, an operator, approve + migrate, a repeated and a foreign swap, a closed swap, numbering, rescuing a stuck drive).

## Server

`LEGACY_CONTRACT_ADDRESS` is the old contract's address, `CONTRACT_ADDRESS` the new one's:

- a drive's owner and capacity come from the new contract, and from the old one for drives not swapped yet;
- a transfer of an old token to the new contract is half of a swap, not a change of owner: links, the key and votes stay; other transfers on the old contract are handled as before;
- a database bound to the old contract moves on to the new one on the first start (`deployment`). Mint counts per tier ("Popular") start afresh: the contracts number their tiers on their own;
- `START_BLOCK` stays the **old** contract's deploy block.

Tests: `a_database_moves_on_to_the_successor_contract`, `a_swapped_drive_keeps_its_data` in `crates/etherdisk-server/tests/api.rs`. The whole path (old contract → new one → the real server on anvil) was checked on 2026-10-15.

## The order of a move

1. **The new contract** inherits `EtherdiskMigration`; its sales and the swap are **closed** at deploy time. Tests and an audit, as for the first one.
2. **Close the old contract's sales for good:** `setTierActive(i, false)` for every tier from the Safe (otherwise new old drives take numbers; `_nextNewTokenId` skips them, but swaps of clashing numbers would fail).
3. **Deploy the new one** (a script modeled on `contracts/script/deploy-mainnet.sh`), verify it on Etherscan.
4. **Server:** `CONTRACT_ADDRESS=<new>`, `LEGACY_CONTRACT_ADDRESS=<old>`, the same `START_BLOCK`; restart. The log says `database moved on to the successor contract`.
5. **Site:** `NEXT_PUBLIC_CONTRACT_ADDRESS=<new>`, a "Move drive" button (calling the old contract's `safeTransferFrom`; made together with the new contract), a build.
6. **Open the swap and the new contract's sales** from the Safe (`setMigrationOpen(true)`, `setTierActive`).
7. Tell the users. Drives not swapped keep working; they can be swapped any time.

Don't open the swap before step 4: a server without `LEGACY_CONTRACT_ADDRESS` would take a swap for a sale and revoke the drive's links.
