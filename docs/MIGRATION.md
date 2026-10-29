# Moving to a new contract

A deployed Etherdisk contract can't be changed. When a new version is needed (new features, a fix), drives move to it **without losing data**: the holder sends the old drive to the new contract and gets a drive with **the same number and capacity** in the same transaction, paying only the network fee. Files, the key, the recovery key, labels and links are bound to the drive's number, so they stay where they are; nothing is re-encrypted.

Every version is built for this: each one inherits `contracts/src/migration/EtherdiskMigration.sol` with the previous version as `legacy` (`address(0)` for v1, the first) and knows its number (`version()`: 1, 2, 3…). Drives move one version at a time (v1 → v2 → v3), whenever their holders like.

## How a move works

- **One transaction:** `legacy.safeTransferFrom(holder, <new contract>, tokenId)`. The new contract passes the old token on to its owner (the Safe) and mints the holder the same number with the same capacity, in the tier of that capacity (event `DriveMigrated`). The number exists on the new contract from then on, so it can't move again: a second try reverts as a whole.
- **For wallets without `safeTransferFrom`:** `legacy.approve(<new contract>, tokenId)`, then `migrate(tokenId)`.
- **Old drives only:** other NFTs, and drives of versions before the previous one, are rejected (`NotLegacyToken`); those move through each version in turn (the site finds the next version on chain, through each contract's `legacy()`).
- **A capacity the new contract has no tier for** reverts with `NoTierForCapacity`: add the tier first (`addTier`; it can stay hidden and off sale).
- **Closed until the owner opens it** (`setMigrationOpen`): the server has to follow the new contract first.
- **New drives' numbers** come after every number of the previous version (`totalSupply` counts them too), so the next version numbers after both. No number is ever handed out twice: the new contract neither mints nor opens moves until the previous one has handed over to it (`setSuccessor(new)` from the Safe: once, only to a contract whose `legacy` it is, and it ends the old contract's sales for good; `LegacyNotHandedOver` otherwise).
- **The old token becomes a legacy one.** It goes to the Safe and its metadata changes (the old contract asks its successor whether the drive is there): "Etherdisk #N · Legacy v1", gray, stamped "LEGACY V1", traits `Status: Legacy` and `Version: v1`, a description pointing to the new version. Marketplaces are told to refresh it (ERC-4906 `MetadataUpdate`). It holds no storage; the Safe never sells it.
- **Sent with a plain `transferFrom`** (no move): the drive is stuck in the new contract. The old contract records who sent it (`sentToSuccessorBy`), so **anyone** completes the move for that wallet: `completeMigration(tokenId)`. Until then the drive opens for nobody.

Tests: `forge test --match-contract EtherdiskMigrationTest` (a move, an operator, approve + migrate, a repeated and a foreign move, a closed move, numbering, the hand-over, a stuck drive, a missing tier, legacy metadata, v1 → v2 → v3).

## Server

`CONTRACT_ADDRESS` is the newest contract; `LEGACY_CONTRACT_ADDRESS` lists the earlier ones, newest first, comma-separated:

- a drive lives on the newest contract that has its number; its holder and capacity come from there;
- a drive still on an earlier contract **opens and downloads as before, but doesn't change**: uploads, folders, renames, moves, deletion, the profile, links, the sale and the handover answer `409 old_contract` until it moves. `GET /api/vaults` shows its `legacy_contract`;
- the halves of a move (holder → new contract → Safe) are no change of hands: links, the key and votes stay. Transfers of an old token whose drive lives on a newer contract (the Safe passing it on) mean nothing to the drive. A sale of a drive that hasn't moved yet is a change of hands as usual, and so is a move's mint to anyone but the holder on record (sold on the old contract and moved before the server saw the sale, or rescued for another wallet);
- a database bound to an earlier contract moves on to the new one on the first start (`deployment`). Mint counts per tier ("Popular") start afresh: each contract numbers its tiers on its own;
- `START_BLOCK` stays the **first** contract's deploy block.

Tests: `a_database_moves_on_to_the_successor_contract`, `a_moved_drive_keeps_its_data`, `a_drive_sold_then_moved_changes_hands` in `crates/etherdisk-server/tests/api.rs`.

## Site

A drive on an earlier contract shows a notice: the contract was updated, move the drive to keep using it. **Move drive** sends the old token to the new contract (`safeTransferFrom`), then waits for the server to see the move. Until then the drive opens read-only: files open and download; uploads, new folders, renames, moves, deletion and settings are off.

The site needs no list of its own: the server names the contract each drive is on (`legacy_contract`).

## The order of an update

1. **The new contract**, with the current one as `legacy`; its sales and moves are **closed** at deploy time. Tests and a review, as for the first one.
2. **Deploy the new one:** `LEGACY=<current> contracts/script/deploy-mainnet.sh`; verify it on Etherscan. Every capacity of the old contract needs a tier on the new one (hidden and off sale is fine).
3. **Hand over:** `setSuccessor(<new>)` on the current contract from the Safe. Irreversible: its sales end for good (its drives keep working).
4. **Server:** `CONTRACT_ADDRESS=<new>`, `LEGACY_CONTRACT_ADDRESS=<current>,<older…>`, the same `START_BLOCK`; restart. The log says `database moved on to the successor contract`.
5. **Site:** `NEXT_PUBLIC_CONTRACT_ADDRESS=<new>`; build and deploy.
6. **Open moves and the new contract's sales** from the Safe (`setMigrationOpen(true)`, `setTierActive`).
7. Tell the users. Drives that haven't moved stay readable; they move whenever their holders like.

Don't open moves before step 4: a server that doesn't follow the new contract would take a move for a sale and revoke the drive's links.
