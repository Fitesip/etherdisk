# Launching on Ethereum mainnet

**The contract on mainnet:** `0x15B87e1e71B48919CfD6fd23089642A1BA48aBf0`, block 26193612, 2026-10-15; owned by the Safe `0xBDcEBBc53331a741316E4faaCf4bfD99D63Ad449` (2 of 3); the deploy took 3,092,394 gas at 0.139 gwei = 0.000430 ETH. The code on chain matches the repository's build; the source is verified on Etherscan and submitted to Sourcify. Deploy data: `contracts/deployments/chain-1.json`. The next version of the contract (renderer, tier colors, royalties; see the CHANGELOG) replaces it with a new deploy following the steps below.

The steps of a mainnet launch. Tiers and prices are in `contracts/mainnet-tiers.env`.

## Cost (mainnet node estimate, 2026-10-15; ETH = $2300)

| Action | Gas | At 0.15 gwei | At 1.5 gwei | At 5 gwei | At 20 gwei |
| --- | --- | --- | --- | --- | --- |
| Deploying the contract | 3,118,104 | ≈ 0.00047 ETH ($1.08) | ≈ 0.0047 ETH ($11) | ≈ 0.016 ETH ($36) | ≈ 0.062 ETH ($143) |
| Minting a drive (the buyer pays) | ≈ 141k | ≈ $0.05 | ≈ $0.49 | ≈ $1.6 | ≈ $6.5 |
| Transferring a drive (the owner pays) | ≈ 60k | ≈ $0.02 | ≈ $0.21 | ≈ $0.7 | ≈ $2.8 |
| `setOperator` / `setTierActive` from the Safe | ≈ 60–90k | ≈ $0.03 | < $0.3 | < $1 | < $4 |

On Sepolia the same deploy costs ≈ 22M gas: the newer, pricier rules for storing code already apply there. If they reach mainnet before the launch, the deploy gets 6–7 times more expensive. Always check the node's fresh estimate before deploying (see step 3), not `forge script`'s.

## 1. A Safe on mainnet

- app.safe.global → the Ethereum network → create a Safe.
- Owners: **2 of 3** (not 2 of 2): say, a hardware wallet, a phone wallet and a spare key kept apart. With "2 of 2", losing either key locks the Safe for good.
- Write down the Safe's address.

## 2. The deployer wallet

- Fund `deployer` (a Foundry keystore) with a margin: the script wants "gas limit × twice the current price". At 0.15 gwei that is ≈ 0.0012 ETH, 0.003 ETH is comfortable; at 1.5 gwei ≈ 0.012 ETH (put 0.02).
- The deployer gets no rights: the Safe is the owner from the start.

## 3. Deploying — `contracts/script/deploy-mainnet.sh`

```bash
cd contracts
OWNER=<Safe address> DEPLOYER=<deployer address> MAX_GWEI=1 ETHERSCAN_API_KEY=<key> ./script/deploy-mainnet.sh
```

Two contracts are deployed: **`EtherdiskRenderer`** (the NFT's picture and metadata; it can be replaced until the metadata is frozen) and **`Etherdisk`** (drives, tiers, payouts). The settings are in `contracts/mainnet-tiers.env`: the tiers, their colors, the royalty (`ROYALTY_BPS`, 500 = 5%) and the drive page address in the metadata (`PAGE_BASE`).

The script:
1. Checks that the RPC is mainnet and that `OWNER` has code (it is the Safe, not a typo).
2. Builds the contracts, takes the node's gas estimate (not `forge script`'s) for both, the gas price and the deployer's balance; prints the expected fee. Stops if the price is above `MAX_GWEI` or the money won't do.
3. Waits for you to type `DEPLOY`; two `forge create` runs with an "estimate × 1.2" limit, each asking for the `deployer` keystore password (the script never sees the key).
4. Checks the contracts on chain: `name`, `owner` = the Safe, `renderer` and its `pageBase`, the royalty, every tier with its price and color from `mainnet-tiers.env`.
5. Saves the addresses, the block and the transactions to `contracts/deployments/chain-1.json`, verifies both sources on Etherscan (when a key is given) and prints the lines for the server's `.env` and the site's build.

If Foundry isn't on PATH: `FOUNDRY_BIN=<folder with forge and cast>`. Without `ETHERSCAN_API_KEY` the script prints the verification commands.

## 4. Checking the contract on chain

```bash
C=<contract address>; R=https://ethereum-rpc.publicnode.com
cast call $C "name()(string)" --rpc-url $R        # Etherdisk
cast call $C "owner()(address)" --rpc-url $R      # the Safe
cast call $C "tierCount()(uint256)" --rpc-url $R  # 6
for i in 0 1 2 3 4 5; do cast call $C "getTier(uint256)((uint32,uint24,bool,bool,uint256))" $i --rpc-url $R; done
cast call $C "renderer()(address)" --rpc-url $R
cast call $C "royaltyInfo(uint256,uint256)(address,uint256)" 1 10000 --rpc-url $R   # the Safe, 500
```

`getTier` returns the capacity, the color (`0xrrggbb` as a number), on sale, hidden and the price.

## 5. Etherscan verification

The API key: etherscan.io → API Keys.

The deploy script verifies both contracts itself when `ETHERSCAN_API_KEY` is set; otherwise it prints both `forge verify-contract` commands with the constructor arguments already encoded (they are also in `contracts/deployments/chain-1.json`).

Once verified, the Safe shows the contract's functions by itself; no need to paste the ABI.

## 6. Operators

From the Safe (Transaction Builder): `setOperator(<moderator's wallet>, true)` for everyone who will open and close tier sales and hide tiers from the site.

What else the owner (the Safe) can do:
- `addTier(capacity, price, color)` — a new tier; not on sale until its sales are opened (`setTierActive`);
- `setTierHidden(tier, true)` — take a tier off the site's lists (drives already bought don't change); operators can too;
- `setTierPrice`, `setTierColor` — the price and the color; a new color changes the pictures of the tier's drives, and marketplaces are told to refresh their cards (ERC-4906);
- `setRenderer` — replace the metadata renderer (fix the picture or the texts); `freezeMetadata()` — forbid that for good (and color changes too);
- `setRoyalty(receiver, bps)` — the royalty on resales, at most 10%.

## 7. Server (`.env`)

```
CHAIN_ID=1
RPC_URL=https://ethereum-rpc.publicnode.com,https://mainnet.gateway.tenderly.co
CONTRACT_ADDRESS=<contract address>
START_BLOCK=<deploy block>
CONFIRMATIONS=3
DATABASE_URL=sqlite:///<database path>/etherdisk.db    # a new database: the old one is bound to the old contract
DATA_DIR=/mnt/raid1/etherdisk                          # volumes, comma-separated
SIWE_DOMAIN=etherdisk.app
CORS_ORIGINS=https://etherdisk.app,http://app.localhost,app://localhost   # the site and the desktop app
TRUST_PROXY=true                                       # behind nginx
IDEAS_ADMINS=<moderators' wallets>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Make each array's mount point read-only while it isn't mounted (`chattr +i` on the empty folder), so the server doesn't take it for a new empty volume.

## 8. Site (`web/.env.local` or build variables)

```
NEXT_PUBLIC_CHAIN_ID=1
NEXT_PUBLIC_API_URL=https://api.etherdisk.app        # or the same domain through nginx
NEXT_PUBLIC_RPC_URL=https://ethereum-rpc.publicnode.com,https://mainnet.gateway.tenderly.co
NEXT_PUBLIC_CONTRACT_ADDRESS=<contract address>
NEXT_PUBLIC_WC_PROJECT_ID=<id from dashboard.reown.com, with etherdisk.app among the allowed domains>
```

`NEXT_PUBLIC_*` are baked in at build time: rebuild after changing them (`npm run build`).

## 9. Checks after the launch

1. The landing page: six tiers, 512 GB, 1 TB and 2 TB marked "Coming soon", no "Sepolia" anywhere.
2. Sign in with a wallet and mint 64 GB: the payment reaches the Safe, and the drive has its picture on Etherscan.
3. Set up the drive, upload a file, create a link and a recovery key.
4. A moderator opens and closes a tier's sales (`setTierActive`) — the site shows the change after a reload.
5. `/status` in Telegram: volumes, database, indexer, RPC without problems.
6. The server's log: `monitor: alerts go to Telegram`, the volumes' free space.

## 10. Later

- Open 512 GB / 1 TB / 2 TB with the operators once storage grows.
- Prices on big moves of the ETH rate: `setTierPrice` from the Safe.
- Money goes straight to the Safe; `withdraw` is only needed when a payout failed (the `PaymentHeld` event).
