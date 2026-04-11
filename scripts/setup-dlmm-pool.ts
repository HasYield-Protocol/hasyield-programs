/**
 * Setup script: Create a SOL/USDC DLMM pool on devnet for HasYield demo.
 * Run: npx ts-node scripts/setup-dlmm-pool.ts
 */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// Devnet token mints
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // Wrapped SOL
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Devnet USDC (common)

async function main() {
  const connection = new Connection(RPC, "confirmed");

  // Load wallet
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(keypairData));
  console.log("Payer:", payer.publicKey.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  // Check if DLMM program exists on devnet
  const programInfo = await connection.getAccountInfo(DLMM_PROGRAM_ID);
  if (!programInfo) {
    console.error("DLMM program not found on devnet!");
    return;
  }
  console.log("DLMM program found on devnet ✓");

  // Try to find existing SOL/USDC pools
  console.log("\nSearching for existing DLMM pools...");
  try {
    const pools = await DLMM.getLbPairs(connection, {
      cluster: "devnet",
    });
    console.log(`Found ${pools.length} DLMM pool(s) on devnet`);

    // Look for SOL/USDC pair
    const solUsdcPool = pools.find(
      (p) =>
        (p.account.tokenXMint.equals(SOL_MINT) && p.account.tokenYMint.equals(USDC_DEVNET)) ||
        (p.account.tokenYMint.equals(SOL_MINT) && p.account.tokenXMint.equals(USDC_DEVNET))
    );

    if (solUsdcPool) {
      console.log("\nFound existing SOL/USDC pool:");
      console.log("  Pool:", solUsdcPool.publicKey.toBase58());
      console.log("  Token X:", solUsdcPool.account.tokenXMint.toBase58());
      console.log("  Token Y:", solUsdcPool.account.tokenYMint.toBase58());
      console.log("  Bin Step:", solUsdcPool.account.binStep);
      writeConstants(solUsdcPool.publicKey);
      return;
    }

    // List first 5 pools for reference
    if (pools.length > 0) {
      console.log("\nAvailable pools:");
      for (const p of pools.slice(0, 5)) {
        console.log(`  ${p.publicKey.toBase58()} — X:${p.account.tokenXMint.toBase58().slice(0, 8)}... Y:${p.account.tokenYMint.toBase58().slice(0, 8)}...`);
      }
    }
  } catch (err) {
    console.log("Could not query pools:", (err as Error).message?.slice(0, 100));
  }

  console.log("\nNo SOL/USDC pool found. You may need to create one via the Meteora devnet UI.");
  console.log("Devnet UI: https://devnet.meteora.ag");
  console.log("\nAlternatively, use any available pool from the list above.");
  console.log("Update the pool address in frontend/src/lib/lp-constants.ts after selecting a pool.");

  // Write placeholder constants
  writeConstants(null);
}

function writeConstants(poolAddress: PublicKey | null) {
  const content = `import { PublicKey } from "@solana/web3.js";

// Meteora DLMM program
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// Demo pool on devnet (SOL/USDC or other pair)
// Run: npx ts-node scripts/setup-dlmm-pool.ts to find/create pools
export const DEMO_POOL_ADDRESS = new PublicKey("${poolAddress?.toBase58() || "11111111111111111111111111111111"}");

// Token mints
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_DEVNET_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// HasYield LP program (to be deployed)
export const LP_VAULT_PROGRAM_ID = new PublicKey("${poolAddress ? "11111111111111111111111111111111" : "11111111111111111111111111111111"}");
`;

  const outPath = path.join(__dirname, "..", "frontend", "src", "lib", "lp-constants.ts");
  fs.writeFileSync(outPath, content);
  console.log(`\nConstants written to ${outPath}`);
}

main().catch(console.error);
