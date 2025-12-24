import "dotenv/config"
import express from "express"
import morgan from "morgan"
import pino from "pino"
import { createPublicClient, createWalletClient, getContract, http, parseAbi, publicActions } from "viem"
import { optimism } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { setTimeout as sleep } from "node:timers/promises"
import pLimit from "p-limit"
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"

const REGISTRY_ABI = [
  {
    type: "function",
    name: "setMerkleRoot",
    stateMutability: "nonpayable",
    inputs: [{ name: "newRoot", type: "bytes32" }],
    outputs: [],
  },
] as const

// ---------------- Logger (string logs only) ----------------
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info"

const logger = pino({
  level: LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
})

// ---- Config ----
const OP_RPC_URL = process.env.OP_RPC_URL!
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY!
const START_FID = Number(process.env.START_FID ?? "1")
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "100")
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "2")
const MAX_FID_OVERRIDE = process.env.MAX_FID ? Number(process.env.MAX_FID) : undefined
const PORT = Number(process.env.PORT ?? "8787")

// refresh interval
const UPDATE_INTERVAL_HOURS = Number(process.env.UPDATE_INTERVAL_HOURS ?? "6")
const UPDATE_INTERVAL_MS = Math.max(1, UPDATE_INTERVAL_HOURS) * 60 * 60 * 1000

// score scaling
const SCORE_SCALE = BigInt(1_000_000)

// Farcaster IdRegistry (Optimism)
const ID_REGISTRY = "0x00000000fc6c5f01fc30151999387bb99a9f489b" as const
const idRegistryAbi = parseAbi(["function idCounter() view returns (uint256)"])

if (!OP_RPC_URL || !NEYNAR_API_KEY) {
  logger.error("Missing OP_RPC_URL or NEYNAR_API_KEY")
  process.exit(1)
}

const opClient = createPublicClient({
  chain: optimism,
  transport: http(OP_RPC_URL),
})

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS as `0x${string}`
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`
const RPC_URL = (process.env.RPC_URL ?? OP_RPC_URL) as string

const account = privateKeyToAccount(PRIVATE_KEY)

const walletClient = createWalletClient({
  account,
  chain: optimism,
  transport: http(RPC_URL),
}).extend(publicActions)

const registry = getContract({
  address: REGISTRY_ADDRESS,
  abi: REGISTRY_ABI,
  client: walletClient,
})

type NeynarUser = {
  fid: number
  experimental?: { neynar_user_score?: number }
  score?: number
}

// ---------------- Global state (tree + index) ----------------
let tree: StandardMerkleTree<string[]> | null = null
let fidToIndex: Map<number, number> | null = null
let fidToScoreScaled: Map<number, bigint> | null = null
let treeMeta: {
  onchainMax: number
  maxFidUsed: number
  startFid: number
  batchSize: number
  concurrency: number
  leafCount: number
  builtAt: string
  buildId: string
} | null = null

let isRefreshing = false // prevents overlapping refreshes

// ---------------- helpers ----------------
function chunk<T>(arr: T[], size: number): T[][] {
  const res: T[][] = []
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size))
  return res
}

async function getMaxFid(): Promise<number> {
  const max = await opClient.readContract({
    address: ID_REGISTRY,
    abi: idRegistryAbi,
    functionName: "idCounter",
  })
  const n = Number(max)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad idCounter(): ${max.toString()}`)
  return n
}

function toScoreScaled(score: number): bigint {
  const s = Number.isFinite(score) ? Math.max(0, score) : 0
  return BigInt(Math.floor(s * Number(SCORE_SCALE)))
}

async function neynarFetchBulkUsers(fids: number[]): Promise<NeynarUser[]> {
  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk")
  url.searchParams.set("fids", fids.join(","))

  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        api_key: NEYNAR_API_KEY,
      },
    })

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1")
      logger.warn(`Rate limited by Neynar (429). attempt=${attempt} retryAfter=${retryAfter}s fidsCount=${fids.length}`)
      await sleep(retryAfter * 1000)
      continue
    }

    if (res.status >= 500) {
      const waitMs = Math.min(30_000, 500 * 2 ** (attempt - 1))
      logger.warn(`Neynar 5xx. attempt=${attempt} status=${res.status} retryInMs=${waitMs}`)
      await sleep(waitMs)
      continue
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Neynar error ${res.status}: ${body}`)
    }

    const json = (await res.json()) as { users?: NeynarUser[] }
    return json.users ?? []
  }

  throw new Error("Neynar request failed after retries")
}

function makeBuildId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function safeErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

// ---------------- API server ----------------
function startServer() {
  const app = express()
  app.use(morgan("tiny"))

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      ready: Boolean(tree && fidToIndex && fidToScoreScaled && treeMeta),
      refreshing: isRefreshing,
      root: tree?.root ?? null,
      leafCount: treeMeta?.leafCount ?? null,
      nextUpdateHours: UPDATE_INTERVAL_HOURS,
      builtAt: treeMeta?.builtAt ?? null,
      buildId: treeMeta?.buildId ?? null,
    })
  })

  app.get("/root", (_req, res) => {
    if (!tree || !treeMeta) return res.status(503).json({ error: "Tree not built yet" })
    res.json({
      root: tree.root,
      leafCount: treeMeta.leafCount,
      scoreScale: SCORE_SCALE.toString(),
      refreshing: isRefreshing,
      meta: treeMeta,
    })
  })

  app.get("/proof/:fid", (req, res) => {
    if (!tree || !fidToIndex || !fidToScoreScaled) {
      return res.status(503).json({ error: "Tree not built yet" })
    }

    const fid = Number(req.params.fid)
    if (!Number.isInteger(fid) || fid <= 0) {
      return res.status(400).json({ error: "Invalid fid" })
    }

    const idx = fidToIndex.get(fid)
    if (idx === undefined) return res.status(404).json({ error: "FID not found in tree" })

    const scoreScaled = fidToScoreScaled.get(fid)
    if (scoreScaled === undefined) return res.status(404).json({ error: "Score not found for fid" })

    res.json({
      root: tree.root,
      fid,
      scoreScaled: scoreScaled.toString(),
      leafIndex: idx,
      proof: tree.getProof(idx),
      leafTypes: ["uint256", "uint256"],
      scoreScale: SCORE_SCALE.toString(),
      builtAt: treeMeta?.builtAt ?? null,
      buildId: treeMeta?.buildId ?? null,
    })
  })

  app.listen(PORT, () => {
    logger.info(`API server started. port=${PORT} updateIntervalHours=${UPDATE_INTERVAL_HOURS} logLevel=${LOG_LEVEL}`)
    logger.info(`Endpoints: GET /health  GET /root  GET /proof/:fid`)
  })
}

// ---------------- build + refresh ----------------
async function buildTreeSnapshot(buildId: string) {
  const onchainMax = await getMaxFid()
  const maxFidUsed = MAX_FID_OVERRIDE ? Math.min(onchainMax, MAX_FID_OVERRIDE) : onchainMax

  const fids: number[] = []
  for (let fid = START_FID; fid <= maxFidUsed; fid++) fids.push(fid)

  const batches = chunk(fids, BATCH_SIZE)
  const totalBatches = batches.length

  logger.info(
    `Starting indexing run. buildId=${buildId} startFid=${START_FID} maxFidUsed=${maxFidUsed} userCount=${
      maxFidUsed - START_FID + 1
    } totalBatches=${totalBatches} batchSize=${BATCH_SIZE} concurrency=${CONCURRENCY}`,
  )

  const limit = pLimit(CONCURRENCY)
  const entries = new Map<number, bigint>()

  let processedBatches = 0
  const startedAt = Date.now()

  await Promise.all(
    batches.map((batch, batchIndex) =>
      limit(async () => {
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const users = await neynarFetchBulkUsers(batch)

            for (const u of users) {
              const rawScore = u?.experimental?.neynar_user_score ?? u?.score ?? 0
              entries.set(u.fid, toScoreScaled(rawScore))
            }

            processedBatches++
            const elapsed = (Date.now() - startedAt) / 1000
            const pct = (processedBatches / totalBatches) * 100
            const avgPerBatch = elapsed / processedBatches
            const eta = avgPerBatch * (totalBatches - processedBatches)

            // debug per batch
            logger.debug(
              `Batch processed. buildId=${buildId} batch=${batchIndex + 1} processed=${processedBatches}/${totalBatches} pct=${pct.toFixed(
                2,
              )}% elapsedSec=${elapsed.toFixed(1)} etaSec=${eta.toFixed(1)} fids=${batch[0]}..${
                batch[batch.length - 1]
              } usersReturned=${users.length}`,
            )

            // info every 25 batches or end
            if (processedBatches % 25 === 0 || processedBatches === totalBatches) {
              logger.info(
                `Indexing progress. buildId=${buildId} processed=${processedBatches}/${totalBatches} pct=${pct.toFixed(
                  2,
                )}% elapsedSec=${elapsed.toFixed(1)} etaSec=${eta.toFixed(1)}`,
              )
            }

            return
          } catch (err) {
            const waitMs = Math.min(30_000, 500 * 2 ** (attempt - 1))
            logger.warn(
              `Batch failed, retrying. buildId=${buildId} batch=${batchIndex + 1} attempt=${attempt} waitMs=${waitMs} err="${safeErr(
                err,
              )}"`,
            )
            await sleep(waitMs)
          }
        }
        throw new Error(`[build ${buildId}] Batch ${batchIndex + 1} failed after retries`)
      }),
    ),
  )

  const sorted = [...entries.entries()].sort((a, b) => a[0] - b[0])
  const values = sorted.map(([fid, score]) => [fid.toString(), score.toString()])
  const nextTree = StandardMerkleTree.of(values, ["uint256", "uint256"])

  const nextFidToIndex = new Map<number, number>()
  const nextFidToScoreScaled = new Map<number, bigint>()
  for (let i = 0; i < sorted.length; i++) {
    const [fid, scoreScaled] = sorted[i]
    nextFidToIndex.set(fid, i)
    nextFidToScoreScaled.set(fid, scoreScaled)
  }

  const nextMeta = {
    onchainMax,
    maxFidUsed,
    startFid: START_FID,
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
    leafCount: values.length,
    builtAt: new Date().toISOString(),
    buildId,
  }

  logger.info(
    `Merkle tree built. buildId=${buildId} root=${nextTree.root} leafCount=${nextMeta.leafCount} builtAt=${nextMeta.builtAt}`,
  )

  return { nextTree, nextFidToIndex, nextFidToScoreScaled, nextMeta }
}

async function refreshTree() {
  if (isRefreshing) {
    logger.warn("Refresh skipped: previous refresh still running")
    return
  }

  isRefreshing = true
  const buildId = makeBuildId()

  logger.info(`Merkle tree refresh started. buildId=${buildId}`)

  try {
    const { nextTree, nextFidToIndex, nextFidToScoreScaled, nextMeta } = await buildTreeSnapshot(buildId)

    const newRoot = nextTree.root as `0x${string}`
    const oldRoot = tree?.root as `0x${string}` | undefined

    if (newRoot !== oldRoot) {
      logger.info(`Updating Merkle root on-chain. buildId=${buildId} oldRoot=${oldRoot ?? "none"} newRoot=${newRoot}`)
      const txHash = await registry.write.setMerkleRoot([newRoot])
      logger.info(`Merkle root update transaction sent. buildId=${buildId} txHash=${txHash}`)
      const receipt = await walletClient.waitForTransactionReceipt({ hash: txHash })
      logger.info(
        `Merkle root update confirmed. buildId=${buildId} txHash=${txHash} blockNumber=${receipt.blockNumber} gasUsed=${receipt.gasUsed?.toString() ?? "unknown"}`,
      )
    } else {
      logger.info(`Merkle root unchanged, skipping on-chain update. buildId=${buildId} root=${newRoot}`)
    }

    // Atomic swap
    tree = nextTree
    fidToIndex = nextFidToIndex
    fidToScoreScaled = nextFidToScoreScaled
    treeMeta = nextMeta

    logger.info(
      `Merkle tree refresh completed. buildId=${buildId} root=${tree.root} leafCount=${treeMeta.leafCount} builtAt=${treeMeta.builtAt}`,
    )
  } catch (e) {
    logger.error(`Merkle tree refresh failed (keeping previous tree). buildId=${buildId} err="${safeErr(e)}"`)
  } finally {
    isRefreshing = false
  }
}

function scheduleRefresh() {
  logger.info(`Scheduled periodic refresh. intervalHours=${UPDATE_INTERVAL_HOURS}`)
  setInterval(() => void refreshTree(), UPDATE_INTERVAL_MS)
}

// ---------------- main ----------------
async function main() {
  logger.info(
    `Indexer configuration loaded. startFid=${START_FID} batchSize=${BATCH_SIZE} concurrency=${CONCURRENCY} updateIntervalHours=${UPDATE_INTERVAL_HOURS} scoreScale=${SCORE_SCALE.toString()} maxFidOverride=${
      MAX_FID_OVERRIDE ?? "none"
    } nodeEnv=${process.env.NODE_ENV ?? "undefined"} logLevel=${LOG_LEVEL}`,
  )

  startServer()
  await refreshTree()
  scheduleRefresh()
}

main().catch((e) => {
  logger.error(`Fatal error. err="${safeErr(e)}"`)
  process.exit(1)
})
