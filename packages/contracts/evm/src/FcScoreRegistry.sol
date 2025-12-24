// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title FcScoreRegistry
 * @notice Stores a Merkle root (owner-only) and verifies proofs for (fid, scoreScaled)
 *         built with OpenZeppelin StandardMerkleTree using types ["uint256","uint256"].
 *
 * leaf values: [fid, scoreScaled] where scoreScaled = floor(neynar_score * 1_000_000)
 *
 * OZ StandardMerkleTree leaf hashing:
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(fid, scoreScaled))));
 *
 * Verification uses OZ MerkleProof (sorted-pairs), matching StandardMerkleTree.
 */
contract FcScoreRegistry is Ownable {
    /// @dev Fixed scaling factor used off-chain for scoreScaled.
    uint256 public constant SCORE_SCALE = 1_000_000;

    /// @notice Current Merkle root for (fid, scoreScaled) leaves.
    bytes32 public merkleRoot;

    event MerkleRootUpdated(bytes32 indexed previousRoot, bytes32 indexed newRoot);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Owner-only root update (e.g., when you re-index / regenerate the tree).
    function setMerkleRoot(bytes32 newRoot) external onlyOwner {
        bytes32 old = merkleRoot;
        merkleRoot = newRoot;
        emit MerkleRootUpdated(old, newRoot);
    }

    /// @notice Computes the OZ StandardMerkleTree leaf for the given fid and scaled score.
    function computeLeaf(uint256 fid, uint256 scoreScaled) public pure returns (bytes32) {
        // IMPORTANT: This matches StandardMerkleTree's leaf hashing
        return keccak256(bytes.concat(keccak256(abi.encode(fid, scoreScaled))));
    }

    /**
     * @notice Verifies a proof for (fid, scoreScaled) against the stored root.
     * @param fid Farcaster id
     * @param scoreScaled Score scaled by 1_000_000 (floor(neynar_score * 1_000_000))
     * @param proof Merkle proof from StandardMerkleTree.getProof(index)
     */
    function verifyScore(uint256 fid, uint256 scoreScaled, bytes32[] calldata proof) external view returns (bool) {
        bytes32 leaf = computeLeaf(fid, scoreScaled);
        return MerkleProof.verify(proof, merkleRoot, leaf);
    }

    /**
     * @notice Convenience helper if callers provide the unscaled score as an integer already
     *         (this does NOT accept decimals; Solidity has no floats).
     *         It's here mainly to expose SCALE in one place.
     */
    function scale() external pure returns (uint256) {
        return SCORE_SCALE;
    }
}
