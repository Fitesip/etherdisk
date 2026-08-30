//! Reads token ownership and capacity from the VaultNFT contract.
//! The contract is the source of truth; the server only caches it briefly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alloy::primitives::{Address, U256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::sol;
use async_trait::async_trait;

use crate::{AppError, AppResult};

sol! {
    #[sol(rpc)]
    interface IVaultNFT {
        event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

        function ownerOf(uint256 tokenId) external view returns (address);
        function capacityOf(uint256 tokenId) external view returns (uint32);
        function tokensOfOwner(address account) external view returns (uint256[] memory);
        function owner() external view returns (address);
    }
}

pub use IVaultNFT::Transfer;

/// What the server needs from the chain. Abstracted so tests can run without an RPC node.
#[async_trait]
pub trait Chain: Send + Sync {
    /// `None` if the token does not exist.
    async fn owner_of(&self, token_id: U256) -> anyhow::Result<Option<Address>>;
    /// Capacity in GB, `None` if the token does not exist.
    async fn capacity_gb(&self, token_id: U256) -> anyhow::Result<Option<u32>>;
    async fn tokens_of_owner(&self, owner: Address) -> anyhow::Result<Vec<U256>>;
    /// The contract's admin (`Ownable.owner()`): moderates the ideas board.
    async fn contract_owner(&self) -> anyhow::Result<Address>;
}

pub struct RpcChain {
    pub provider: DynProvider,
    pub contract: IVaultNFT::IVaultNFTInstance<DynProvider>,
}

impl RpcChain {
    pub fn new(rpc_url: &str, contract: Address) -> anyhow::Result<Self> {
        let provider = ProviderBuilder::new().connect_http(rpc_url.parse()?).erased();
        Ok(Self { contract: IVaultNFT::new(contract, provider.clone()), provider })
    }
}

/// `ownerOf`/`capacityOf` revert for nonexistent tokens; anything else is a real error.
fn none_if_reverted<T>(r: Result<T, alloy::contract::Error>) -> anyhow::Result<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.as_revert_data().is_some() => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[async_trait]
impl Chain for RpcChain {
    async fn owner_of(&self, token_id: U256) -> anyhow::Result<Option<Address>> {
        none_if_reverted(self.contract.ownerOf(token_id).call().await)
    }

    async fn capacity_gb(&self, token_id: U256) -> anyhow::Result<Option<u32>> {
        none_if_reverted(self.contract.capacityOf(token_id).call().await)
    }

    async fn tokens_of_owner(&self, owner: Address) -> anyhow::Result<Vec<U256>> {
        Ok(self.contract.tokensOfOwner(owner).call().await?)
    }

    async fn contract_owner(&self) -> anyhow::Result<Address> {
        Ok(self.contract.owner().call().await?)
    }
}

/// Bytes per GB of tier capacity (binary GB, like Windows shows disk sizes).
pub const BYTES_PER_GB: u64 = 1 << 30;

/// Caches chain reads. Owners expire after `ttl` and are dropped early by the
/// Transfer indexer; capacity is immutable per token, so it is cached forever.
pub struct Ownership {
    chain: Arc<dyn Chain>,
    ttl: Duration,
    owners: Mutex<HashMap<U256, (Address, Instant)>>,
    capacity: Mutex<HashMap<U256, u32>>,
}

impl Ownership {
    pub fn new(chain: Arc<dyn Chain>, ttl: Duration) -> Self {
        Self { chain, ttl, owners: Mutex::default(), capacity: Mutex::default() }
    }

    pub async fn owner_of(&self, token_id: U256) -> AppResult<Option<Address>> {
        if let Some(&(owner, at)) = self.owners.lock().unwrap().get(&token_id) {
            if at.elapsed() < self.ttl {
                return Ok(Some(owner));
            }
        }
        let owner = self.chain.owner_of(token_id).await?;
        if let Some(owner) = owner {
            self.owners.lock().unwrap().insert(token_id, (owner, Instant::now()));
        }
        Ok(owner)
    }

    /// Ok if `who` currently owns the token; 404 if it does not exist, 403 otherwise.
    pub async fn require_owner(&self, token_id: U256, who: Address) -> AppResult<()> {
        match self.owner_of(token_id).await? {
            None => Err(AppError::NotFound),
            Some(owner) if owner == who => Ok(()),
            Some(_) => {
                // The cache may predate a transfer the indexer hasn't seen yet: a new owner
                // must not be turned away for up to `ttl`. Ask the chain once more.
                self.invalidate(token_id);
                match self.owner_of(token_id).await? {
                    Some(owner) if owner == who => Ok(()),
                    None => Err(AppError::NotFound),
                    Some(_) => Err(AppError::Forbidden),
                }
            }
        }
    }

    pub async fn capacity_bytes(&self, token_id: U256) -> AppResult<u64> {
        if let Some(&gb) = self.capacity.lock().unwrap().get(&token_id) {
            return Ok(gb as u64 * BYTES_PER_GB);
        }
        let gb = self.chain.capacity_gb(token_id).await?.ok_or(AppError::NotFound)?;
        self.capacity.lock().unwrap().insert(token_id, gb);
        Ok(gb as u64 * BYTES_PER_GB)
    }

    pub async fn tokens_of_owner(&self, owner: Address) -> AppResult<Vec<U256>> {
        Ok(self.chain.tokens_of_owner(owner).await?)
    }

    pub async fn is_admin(&self, who: Address) -> AppResult<bool> {
        Ok(self.chain.contract_owner().await? == who)
    }

    pub fn invalidate(&self, token_id: U256) {
        self.owners.lock().unwrap().remove(&token_id);
    }
}
