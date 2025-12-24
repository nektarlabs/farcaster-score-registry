# farcaster-score-registry

Builds an **OpenZeppelin-compatible Merkle tree** of `(fid, scoreScaled)` from **Neynar user scores**, serves Merkle proofs via an API, and **updates an on-chain Merkle root** on `FcScoreRegistry`, enabling on-chain applications to efficiently and trustlessly verify Neynar scores directly on-chain.

---

## What it does

* Reads the latest Farcaster `fid` counter from the **IdRegistry on Optimism**
* Fetches users in batches from **Neynar**
* Computes:

`scoreScaled = floor(neynar_user_score * 1_000_000)`

* Builds an **OpenZeppelin StandardMerkleTree** with leaf types:

`["uint256", "uint256"]` → `[fid, scoreScaled]`

* Keeps the tree **in memory** and exposes a simple API:

  * `GET /root` → current root
  * `GET /proof/:fid` → proof for a fid
* Rebuilds automatically every `UPDATE_INTERVAL_HOURS`
* Sends `setMerkleRoot(root)` to your deployed contract

---

## Requirements

* Node.js **18+**
* pnpm
* Neynar API key
* Optimism RPC URL
* (optional) Deployed `FcScoreRegistry` + owner private key

---

## Install

```bash
pnpm install
```

---

## Configure

Create `.env`:

```env
# Required
OP_RPC_URL=https://mainnet.optimism.io
NEYNAR_API_KEY=your_neynar_api_key

# API
PORT=8787

# Indexing
START_FID=1
BATCH_SIZE=100
CONCURRENCY=2
UPDATE_INTERVAL_HOURS=6
# MAX_FID=5000

# Logging
LOG_LEVEL=info
NODE_ENV=development

# Optional: on-chain root update
REGISTRY_ADDRESS=0xYourDeployedFcScoreRegistry
PRIVATE_KEY=0xOwnerPrivateKey
RPC_URL=https://mainnet.optimism.io
```

Notes:

* `BATCH_SIZE` should be `<= 100` (Neynar bulk limit).
* `MAX_FID` is helpful for testing.
* `RPC_URL` defaults to `OP_RPC_URL` if you set it that way in code.

---

## Run (Development)

```bash
pnpm dev
```

**What happens:**

* The HTTP API starts immediately.
* A full Merkle tree build begins in the background.
* While the initial build is in progress, `/root` and `/proof/:fid` return `503 (Service Unavailable)`.
* Once the build completes, the API begins serving Merkle roots and proofs.
* The Merkle tree is automatically rebuilt every `UPDATE_INTERVAL_HOURS`.

---

## Run (Production)

```bash
pnpm build
pnpm start
```

* Runs the compiled build with the same behavior as development mode.
* Intended for long-running, production deployments.

---


## API

### Health

```bash
curl http://localhost:8787/health
```

### Current Merkle root

```bash
curl http://localhost:8787/root
```

### Merkle proof for a FID

```bash
curl http://localhost:8787/proof/1
```

Response (example):

```json
{
  "root": "0x...",
  "fid": 1,
  "scoreScaled": "734219",
  "leafIndex": 0,
  "proof": ["0x...", "0x..."],
  "leafTypes": ["uint256", "uint256"],
  "scoreScale": "1000000"
}
```

---

## On-chain verification (Solidity)

Proofs are compatible with OpenZeppelin `MerkleProof` and StandardMerkleTree leaves:

```solidity
bytes32 leaf =
  keccak256(bytes.concat(keccak256(abi.encode(fid, scoreScaled))));

require(MerkleProof.verify(proof, root, leaf), "Invalid proof");
```

---

## TODO

* Add TEE attestation to cryptographically verify that the indexer executed correctly and produced the published Merkle root from the intended code and inputs. This would allow consumers to trust not only the Merkle proofs, but also the integrity of the indexing process itself.

---

## License

MIT

---

## ⚠️ Disclaimer

This project is **work in progress (WIP)**.

* The API, data model, and on-chain integration **may change**
* Do **not** rely on this for production or financial decisions yet

Feedback, discussion, and contributions are welcome while the design is still evolving.
