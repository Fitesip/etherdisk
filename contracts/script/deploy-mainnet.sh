#!/usr/bin/env bash
# Deploys Etherdisk to Ethereum mainnet: first its metadata renderer, then the token contract
# with the agreed tiers, colors and royalty (mainnet-tiers.env). Then checks both on chain and
# (optionally) verifies them on Etherscan. See docs/LAUNCH.md.
#
# Usage (from contracts/):
#   OWNER=0x<Safe> DEPLOYER=0x<deployer address> ./script/deploy-mainnet.sh
#
# The deployer signs with the Foundry keystore account "deployer": forge asks for its password
# (once per transaction: two). The script never sees a private key.
#
# Optional:
#   RPC_URL            default https://ethereum-rpc.publicnode.com
#   MAX_GWEI           refuse to deploy when the gas price is above this (e.g. 1)
#   ETHERSCAN_API_KEY  verify the sources on Etherscan after the deploy
#   FOUNDRY_BIN        folder with forge/cast if they are not on PATH
#   WALLET_ARGS        how forge signs, default "--account deployer"
#   EXPECT_CHAIN_ID    default 1; ALLOW_EOA_OWNER=1 allows a non-contract owner (local tests only)
set -euo pipefail

cd "$(dirname "$0")/.."
bin() { if [[ -n "${FOUNDRY_BIN:-}" ]]; then echo "$FOUNDRY_BIN/$1"; else echo "$1"; fi; }
FORGE=$(bin forge)
CAST=$(bin cast)
RPC_URL=${RPC_URL:-https://ethereum-rpc.publicnode.com}
EXPECT_CHAIN_ID=${EXPECT_CHAIN_ID:-1}
WALLET_ARGS=${WALLET_ARGS:---account deployer}
die() { echo "error: $*" >&2; exit 1; }
gwei() { awk -v w="$1" 'BEGIN { printf "%.3f", w / 1e9 }'; }
eth() { awk -v w="$1" 'BEGIN { printf "%.6f", w / 1e18 }'; }
bytecode() {
  python -c "import json;print(json.load(open('out/$1.sol/$1.json'))['bytecode']['object'])" 2>/dev/null ||
    node -e "console.log(require('./out/$1.sol/$1.json').bytecode.object)"
}

[[ ${OWNER:-} =~ ^0x[0-9a-fA-F]{40}$ ]] || die "OWNER must be the Safe's address (0x…)"
[[ ${DEPLOYER:-} =~ ^0x[0-9a-fA-F]{40}$ ]] || die "DEPLOYER must be the deployer's address (0x…), the one in the keystore"

# Tiers: comma lists from mainnet-tiers.env -> "[a,b,c]".
# shellcheck disable=SC1091
source mainnet-tiers.env
CAPS="[$TIER_CAPACITIES_GB]"
PRICES="[$TIER_PRICES_WEI]"
ACTIVE="[$TIER_ACTIVE]"
COLORS="[$TIER_COLORS]"
SIG="constructor(address,address,uint32[],uint256[],bool[],uint24[],uint96)"
RSIG="constructor(string)"

echo "== Checks"
chain=$("$CAST" chain-id --rpc-url "$RPC_URL")
[[ $chain == "$EXPECT_CHAIN_ID" ]] || die "RPC is on chain $chain, expected $EXPECT_CHAIN_ID"
code=$("$CAST" code "$OWNER" --rpc-url "$RPC_URL")
if [[ $code == "0x" && -z ${ALLOW_EOA_OWNER:-} ]]; then
  die "OWNER $OWNER has no code: it is not a Safe on this chain (wrong address or wrong network?)"
fi
echo "chain $chain, owner $OWNER (contract: $([[ $code == 0x ]] && echo no || echo yes))"

"$FORGE" build >/dev/null
RBYTECODE=$(bytecode EtherdiskRenderer)
BYTECODE=$(bytecode Etherdisk)

# Etherdisk's constructor only checks the renderer address isn't zero: any address estimates it.
restimate=$("$CAST" estimate --rpc-url "$RPC_URL" --from "$DEPLOYER" --create "$RBYTECODE" "$RSIG" "$PAGE_BASE")
estimate=$("$CAST" estimate --rpc-url "$RPC_URL" --from "$DEPLOYER" --create "$BYTECODE" "$SIG" "$OWNER" "$DEPLOYER" "$CAPS" "$PRICES" "$ACTIVE" "$COLORS" "$ROYALTY_BPS")
rlimit=$((restimate * 12 / 10))
limit=$((estimate * 12 / 10))
price=$("$CAST" gas-price --rpc-url "$RPC_URL")
balance=$("$CAST" balance "$DEPLOYER" --rpc-url "$RPC_URL")
cost=$(awk -v g="$((estimate + restimate))" -v p="$price" 'BEGIN { printf "%.0f", g * p }')
worst=$(awk -v g="$((limit + rlimit))" -v p="$price" 'BEGIN { printf "%.0f", g * p * 2 }')

echo
echo "== Deploy"
echo "tiers (GB):    $CAPS"
echo "prices (wei):  $PRICES"
echo "on sale:       $ACTIVE"
echo "colors:        $COLORS"
echo "royalty:       $ROYALTY_BPS bps to the owner"
echo "drive page:    ${PAGE_BASE}<id>"
echo "gas:           renderer $restimate + Etherdisk $estimate (limits $rlimit, $limit)"
echo "gas price now: $(gwei "$price") gwei"
echo "expected fee:  $(eth "$cost") ETH"
echo "deployer:      $DEPLOYER, balance $(eth "$balance") ETH"
if [[ -n ${MAX_GWEI:-} ]] && awk -v p="$price" -v m="$MAX_GWEI" 'BEGIN { exit !(p / 1e9 > m) }'; then
  die "gas price $(gwei "$price") gwei is above MAX_GWEI=$MAX_GWEI; try later"
fi
if awk -v b="$balance" -v w="$worst" 'BEGIN { exit !(b < w) }'; then
  die "the deployer needs at least $(eth "$worst") ETH (limits x twice today's price) to send both transactions"
fi

echo
read -r -p "Type DEPLOY to send the two transactions: " answer
[[ $answer == DEPLOY ]] || die "cancelled"

# Prints "<address> <tx>" of a `forge create --json`.
created() {
  local address tx
  address=$(echo "$1" | sed -n 's/.*"deployedTo"[^"]*"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)
  tx=$(echo "$1" | sed -n 's/.*"transactionHash"[^"]*"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)
  [[ -n $address && -n $tx ]] || die "could not read the result of forge create: $1"
  echo "$address $tx"
}
report() {
  local used paid
  used=$("$CAST" receipt "$2" gasUsed --rpc-url "$RPC_URL")
  paid=$("$CAST" receipt "$2" effectiveGasPrice --rpc-url "$RPC_URL")
  echo "$1 in block $("$CAST" receipt "$2" blockNumber --rpc-url "$RPC_URL") (tx $2), gas $used at $(gwei "$paid") gwei = $(eth "$((used * paid))") ETH"
}

# shellcheck disable=SC2086
out=$("$FORGE" create src/EtherdiskRenderer.sol:EtherdiskRenderer --rpc-url "$RPC_URL" $WALLET_ARGS --broadcast --json \
  --gas-limit "$rlimit" --constructor-args "$PAGE_BASE")
read -r RENDERER RTX <<<"$(created "$out")"
report "renderer $RENDERER" "$RTX"

# shellcheck disable=SC2086
out=$("$FORGE" create src/Etherdisk.sol:Etherdisk --rpc-url "$RPC_URL" $WALLET_ARGS --broadcast --json \
  --gas-limit "$limit" --constructor-args "$OWNER" "$RENDERER" "$CAPS" "$PRICES" "$ACTIVE" "$COLORS" "$ROYALTY_BPS")
read -r ADDRESS TX <<<"$(created "$out")"
BLOCK=$("$CAST" receipt "$TX" blockNumber --rpc-url "$RPC_URL")
report "Etherdisk $ADDRESS" "$TX"

echo
echo "== On-chain check"
call() { "$CAST" call "$ADDRESS" "$@" --rpc-url "$RPC_URL"; }
[[ $(call "name()(string)") == '"Etherdisk"' ]] || die "name() is not Etherdisk"
owner=$(call "owner()(address)")
[[ ${owner,,} == "${OWNER,,}" ]] || die "owner() is $owner, expected $OWNER"
renderer=$(call "renderer()(address)")
[[ ${renderer,,} == "${RENDERER,,}" ]] || die "renderer() is $renderer, expected $RENDERER"
[[ $("$CAST" call "$RENDERER" "pageBase()(string)" --rpc-url "$RPC_URL") == "\"$PAGE_BASE\"" ]] || die "the renderer's pageBase is not $PAGE_BASE"
royalty=$(call "royaltyInfo(uint256,uint256)(address,uint256)" 1 10000 | tr '\n' ' ')
[[ ${royalty,,} == "${OWNER,,} $ROYALTY_BPS " ]] || die "royaltyInfo is ($royalty), expected ($OWNER $ROYALTY_BPS)"
IFS=, read -r -a caps <<<"$TIER_CAPACITIES_GB"
IFS=, read -r -a prices <<<"$TIER_PRICES_WEI"
IFS=, read -r -a active <<<"$TIER_ACTIVE"
IFS=, read -r -a colors <<<"$TIER_COLORS"
[[ $(call "tierCount()(uint256)") == "${#caps[@]}" ]] || die "tierCount() is not ${#caps[@]}"
for i in "${!caps[@]}"; do
  tier=$(call "getTier(uint256)((uint32,uint24,bool,bool,uint256))" "$i")
  # "(64, 6514417 [6.514e6], true, false, 5000000000000000 [5e15])" -> "64 6514417 true false 5000000000000000"
  got=$(echo "$tier" | sed -E 's/\[[^]]*\]//g; s/[(),]//g; s/ +/ /g; s/^ | $//g')
  want="${caps[$i]} $((colors[i])) ${active[$i]} false ${prices[$i]}"
  [[ $got == "$want" ]] || die "tier $i is ($got), expected ($want)"
  echo "tier $i: ${caps[$i]} GB, color ${colors[$i]}, on sale: ${active[$i]}, ${prices[$i]} wei"
done
echo "owner, name, renderer, royalty and tiers match"

RARGS=$("$CAST" abi-encode "$RSIG" "$PAGE_BASE")
ARGS=$("$CAST" abi-encode "$SIG" "$OWNER" "$RENDERER" "$CAPS" "$PRICES" "$ACTIVE" "$COLORS" "$ROYALTY_BPS")
mkdir -p deployments
cat >"deployments/chain-$chain.json" <<EOF
{
  "chainId": $chain,
  "address": "$ADDRESS",
  "block": $BLOCK,
  "transaction": "$TX",
  "owner": "$OWNER",
  "constructorArgs": "$ARGS",
  "renderer": {
    "address": "$RENDERER",
    "transaction": "$RTX",
    "constructorArgs": "$RARGS"
  }
}
EOF
echo "saved deployments/chain-$chain.json"

if [[ -n ${ETHERSCAN_API_KEY:-} ]]; then
  echo
  echo "== Etherscan"
  "$FORGE" verify-contract "$RENDERER" src/EtherdiskRenderer.sol:EtherdiskRenderer --chain-id "$chain" \
    --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$RARGS" --watch
  "$FORGE" verify-contract "$ADDRESS" src/Etherdisk.sol:Etherdisk --chain-id "$chain" \
    --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$ARGS" --watch
else
  echo
  echo "Not verified on Etherscan (no ETHERSCAN_API_KEY). Later:"
  echo "  forge verify-contract $RENDERER src/EtherdiskRenderer.sol:EtherdiskRenderer --chain-id $chain --etherscan-api-key <key> --constructor-args $RARGS --watch"
  echo "  forge verify-contract $ADDRESS src/Etherdisk.sol:Etherdisk --chain-id $chain --etherscan-api-key <key> --constructor-args $ARGS --watch"
fi

echo
echo "== Next (docs/LAUNCH.md, steps 6-9)"
echo "server .env:  CHAIN_ID=$chain  CONTRACT_ADDRESS=$ADDRESS  START_BLOCK=$BLOCK"
echo "web build:    NEXT_PUBLIC_CHAIN_ID=$chain  NEXT_PUBLIC_CONTRACT_ADDRESS=$ADDRESS"
echo "Safe:         setOperator(<moderator>, true) for each moderator"
