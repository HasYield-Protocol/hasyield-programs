/**
 * Yield Rate Cranker — fetches protocol yields, computes optimal Marinade
 * allocation, and calls the vault's `rebalance` instruction when the delta
 * exceeds a threshold.
 *
 * Run:  ts-node scripts/rebalance-cranker.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LP_VAULT_PROGRAM = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");

const VAULT_CONFIG_PUBKEY = new PublicKey("5hAGZFirTf7yB9MAfF4MN2iyQ89xDjSewymBAJ5gKZ21");

// Marinade addresses (devnet)
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
const TREASURY_MSOL_DEVNET = new PublicKey("8ZUcztoAEhpAeC2ixWewJKQJsSUGYSGPVAjkhDJYf5Gd");

// Derived Marinade PDAs
const [RESERVE_PDA] = PublicKey.findProgramAddressSync(
  [MARINADE_STATE.toBuffer(), Buffer.from("reserve")], MARINADE_PROGRAM,
);
const [LIQ_SOL_LEG] = PublicKey.findProgramAddressSync(
  [MARINADE_STATE.toBuffer(), Buffer.from("liq_sol")], MARINADE_PROGRAM,
);
const [LIQ_MSOL_AUTH] = PublicKey.findProgramAddressSync(
  [MARINADE_STATE.toBuffer(), Buffer.from("liq_st_sol_authority")], MARINADE_PROGRAM,
);
const [MSOL_MINT_AUTH] = PublicKey.findProgramAddressSync(
  [MARINADE_STATE.toBuffer(), Buffer.from("st_mint")], MARINADE_PROGRAM,
);

// Token mints for vault PDA derivation
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Cranker parameters
const DLMM_APY_CONSTANT = 0.12;        // 12% — configurable placeholder
const REBALANCE_THRESHOLD_BPS = 500;    // only rebalance if delta > 5%
const MIN_MARINADE_BPS = 1000;          // 10%
const MAX_MARINADE_BPS = 5000;          // 50%
const DEFAULT_MARINADE_BPS = 3000;      // 30%

// Byte offset of `marinade_allocation_bps` (u16 LE) inside LpVaultConfig account data:
//   8 disc + 32 authority + 32 lb_pair + 32 hylp_mint + 32 position
//   + 8 total_deposited_x + 8 total_deposited_y + 8 total_shares + 8 deposit_count
//   + 4 lower_bin_id + 4 width + 1 position_initialized + 1 bump + 1 vault_authority_bump
//   = 179
const MARINADE_BPS_OFFSET = 179;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

/** Fetch Marinade 30-day rolling APY. Returns a decimal (e.g. 0.072 = 7.2%). */
async function fetchMarinadeApy(): Promise<number> {
  const resp = await fetch("https://api.marinade.finance/msol/apy/30d");
  if (!resp.ok) throw new Error(`Marinade API error: ${resp.status} ${resp.statusText}`);
  const apy = Number(await resp.text());
  if (isNaN(apy)) throw new Error("Marinade API returned non-numeric APY");
  return apy;
}

/**
 * Compute optimal Marinade allocation in bps based on its APY.
 *   APY >= 5% → scale up toward MAX (50%)
 *   APY <= 3% → scale down toward MIN (10%)
 *   In between → default 30%
 *
 * Linear interpolation between boundaries.
 */
function computeOptimalBps(marinadeApy: number): number {
  const pct = marinadeApy * 100; // convert to percentage

  if (pct >= 5) {
    // Interpolate 5% → 10% APY maps to 3000 → 5000 bps
    const t = Math.min((pct - 5) / 5, 1); // clamp at 10%
    return Math.round(DEFAULT_MARINADE_BPS + t * (MAX_MARINADE_BPS - DEFAULT_MARINADE_BPS));
  } else if (pct <= 3) {
    // Interpolate 0% → 3% APY maps to 1000 → 3000 bps
    const t = Math.min(pct / 3, 1);
    return Math.round(MIN_MARINADE_BPS + t * (DEFAULT_MARINADE_BPS - MIN_MARINADE_BPS));
  } else {
    return DEFAULT_MARINADE_BPS;
  }
}

/** Read the current marinade_allocation_bps from on-chain vault config. */
async function readCurrentAllocation(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(VAULT_CONFIG_PUBKEY);
  if (!info) throw new Error("Vault config account not found on-chain");
  return info.data.readUInt16LE(MARINADE_BPS_OFFSET);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );

  console.log("═══════════════════════════════════════════════════");
  console.log("HasYield Rebalance Cranker");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:          ", payer.publicKey.toBase58());
  console.log("Vault Config:   ", VAULT_CONFIG_PUBKEY.toBase58());
  console.log("DLMM APY (cfg): ", (DLMM_APY_CONSTANT * 100).toFixed(1) + "%");

  // ── Step 1: Fetch yields ──────────────────────────────────────────────────
  let marinadeApy: number;
  try {
    marinadeApy = await fetchMarinadeApy();
    console.log("Marinade APY:   ", (marinadeApy * 100).toFixed(2) + "%");
  } catch (err: any) {
    console.error("Failed to fetch Marinade APY:", err.message);
    console.log("Falling back to 0% (conservative — will reduce allocation)");
    marinadeApy = 0;
  }

  // ── Step 2: Compute optimal allocation ────────────────────────────────────
  const optimalBps = computeOptimalBps(marinadeApy);

  // ── Step 3: Read current on-chain allocation ──────────────────────────────
  let currentBps: number;
  try {
    currentBps = await readCurrentAllocation(connection);
  } catch (err: any) {
    console.error("Failed to read vault config:", err.message);
    process.exit(1);
  }

  const deltaBps = Math.abs(optimalBps - currentBps);

  console.log("");
  console.log("Current allocation: ", currentBps, `bps (${(currentBps / 100).toFixed(1)}%)`);
  console.log("Optimal allocation: ", optimalBps, `bps (${(optimalBps / 100).toFixed(1)}%)`);
  console.log("Delta:              ", deltaBps, "bps");

  // ── Step 4: Decide whether to rebalance ───────────────────────────────────
  if (deltaBps <= REBALANCE_THRESHOLD_BPS) {
    console.log(`\nDelta ${deltaBps} bps <= threshold ${REBALANCE_THRESHOLD_BPS} bps -> NO REBALANCE NEEDED`);
    process.exit(0);
  }

  console.log(`\nDelta ${deltaBps} bps > threshold ${REBALANCE_THRESHOLD_BPS} bps -> REBALANCING`);

  // ── Step 5: Build and send rebalance transaction ──────────────────────────

  // Derive vault PDAs
  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp-vault-config"), USDC_MINT.toBuffer(), WSOL_MINT.toBuffer()],
    LP_VAULT_PROGRAM,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority"), vaultConfig.toBuffer()],
    LP_VAULT_PROGRAM,
  );

  // Vault authority's mSOL ATA
  const vaultMsolAta = getAssociatedTokenAddressSync(
    MSOL_MINT, vaultAuthority, true, TOKEN_PROGRAM_ID,
  );

  // Build instruction data: 8-byte discriminator + 2-byte new_marinade_bps (u16 LE)
  const data = Buffer.alloc(8 + 2);
  disc("rebalance").copy(data, 0);
  data.writeUInt16LE(optimalBps, 8);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    {
      programId: LP_VAULT_PROGRAM,
      keys: [
        // Authority (signer)
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        // Vault accounts
        { pubkey: vaultConfig, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        // Marinade accounts (same layout as deposit_to_marinade)
        { pubkey: MARINADE_STATE, isSigner: false, isWritable: true },
        { pubkey: MSOL_MINT, isSigner: false, isWritable: true },
        { pubkey: LIQ_SOL_LEG, isSigner: false, isWritable: true },
        { pubkey: LIQ_POOL_MSOL_LEG, isSigner: false, isWritable: true },
        { pubkey: LIQ_MSOL_AUTH, isSigner: false, isWritable: false },
        { pubkey: RESERVE_PDA, isSigner: false, isWritable: true },
        { pubkey: vaultMsolAta, isSigner: false, isWritable: true },
        { pubkey: MSOL_MINT_AUTH, isSigner: false, isWritable: false },
        { pubkey: TREASURY_MSOL_DEVNET, isSigner: false, isWritable: true },
        // Programs
        { pubkey: MARINADE_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    },
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("\nRebalance TX confirmed:", sig);
    console.log(`Updated marinade_allocation_bps: ${currentBps} -> ${optimalBps}`);
  } catch (err: any) {
    console.error("\nRebalance TX failed:", err.message?.slice(0, 500));
    if (err.logs) {
      console.log("\nProgram logs:");
      for (const log of err.logs.slice(-15)) console.log("  ", log);
    }
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("CRANKER COMPLETE");
  console.log("═══════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
