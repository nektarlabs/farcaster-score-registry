# indexer

This service builds a **Merkle tree of Farcaster FIDs + Neynar scores** and exposes a small HTTP API to retrieve:

- the **current Merkle root**
- **Merkle proofs** for a given `fid`

The tree is **rebuilt automatically every X hours** and kept **in memory** so proof requests are fast and do not trigger
new Neynar calls.

---

## Requirements

- Node.js **18+**
- pnpm
- Optimism RPC URL
- Neynar API key

---

## Install

```bash
pnpm install
```

---

## Environment Variables

Create a `.env` file:

```env
OP_RPC_URL=https://mainnet.optimism.io
NEYNAR_API_KEY=your_neynar_api_key

# API
PORT=8787

# Indexing
START_FID=1
BATCH_SIZE=100
CONCURRENCY=2
UPDATE_INTERVAL_HOURS=6

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

---

## Start the API

```bash
pnpm dev
```

On startup:

1. The HTTP API starts immediately
2. The indexer builds the Merkle tree in the background
3. Once built, the API begins serving roots and proofs
4. The tree is refreshed every `UPDATE_INTERVAL_HOURS`

---

## API Endpoints

### Health

```bash
GET /health
```

Returns readiness and build status.

---

### Get Merkle Root

```bash
GET /root
```

Response:

```json
{
  "root": "0x...",
  "leafCount": 123456,
  "scoreScale": "1000000"
}
```

---

### Get Proof for a FID

```bash
GET /proof/:fid
```

Example:

```bash
GET /proof/1
```

Response:

```json
{
  "root": "0x...",
  "fid": 1,
  "scoreScaled": "734219",
  "leafIndex": 0,
  "proof": ["0x...", "0x..."]
}
```

---

## On-chain Verification

Proofs are compatible with OpenZeppelin `MerkleProof`:

```solidity
bytes32 leaf =
  keccak256(
    bytes.concat(
      keccak256(abi.encode(fid, scoreScaled))
    )
  );

require(MerkleProof.verify(proof, root, leaf), "Invalid proof");
```

---

## Notes

- Proofs are generated from an **in-memory Merkle tree**
- No Neynar API calls are made when serving `/proof`
- If a refresh fails, the previous tree remains active
- Increase `LOG_LEVEL=debug` to see per-batch progress
