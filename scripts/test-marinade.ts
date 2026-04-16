/**
 * Test Marinade staking CPI — deposit SOL → receive mSOL via vault PDA.
 * Run: ts-node scripts/test-marinade.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LP_VAULT_PROGRAM = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");

// Marinade addresses (same on devnet)
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
const TREASURY_MSOL_DEVNET = new PublicKey("8ZUcztoAEhpAeC2ixWewJKQJsSUGYSGPVAjkhDJYf5Gd");

// Derived PDAs
const [RESERVE_PDA] = PublicKey.findProgramAddressSync([MARINADE_STATE.toBuffer(), Buffer.from("reserve")], MARINADE_PROGRAM);
const [LIQ_SOL_LEG] = PublicKey.findProgramAddressSync([MARINADE_STATE.toBuffer(), Buffer.from("liq_sol")], MARINADE_PROGRAM);
const [LIQ_MSOL_AUTH] = PublicKey.findProgramAddressSync([MARINADE_STATE.toBuffer(), Buffer.from("liq_st_sol_authority")], MARINADE_PROGRAM);
const [MSOL_MINT_AUTH] = PublicKey.findProgramAddressSync([MARINADE_STATE.toBuffer(), Buffer.from("st_mint")], MARINADE_PROGRAM);

// Vault constants
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  console.log("═══════════════════════════════════════════════════");
  console.log("Marinade Staking CPI Test");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // Derive vault PDAs
  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp-vault-config"), USDC_MINT.toBuffer(), WSOL_MINT.toBuffer()],
    LP_VAULT_PROGRAM
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority"), vaultConfig.toBuffer()],
    LP_VAULT_PROGRAM
  );

  console.log("Vault Config:", vaultConfig.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());

  // Vault authority needs SOL for the Marinade deposit.
  // The vault_authority PDA is a system account, so we need to fund it.
  const vaultAuthBalance = await connection.getBalance(vaultAuthority);
  console.log("Vault Authority SOL balance:", vaultAuthBalance / LAMPORTS_PER_SOL);

  const depositLamports = 1_000_000; // 0.001 SOL

  // Vault authority is a PDA (system account) — needs enough SOL for deposit + rent exempt minimum
  const rentExempt = 890_880; // min for 0-byte system account
  const needed = depositLamports + rentExempt + 10_000;

  if (vaultAuthBalance < needed) {
    console.log("  Funding vault authority with SOL...");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: vaultAuthority,
        lamports: needed - vaultAuthBalance,
      })
    );
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    console.log("  Funded vault authority");
  }

  // Create vault's mSOL ATA if needed
  const vaultMsolAta = getAssociatedTokenAddressSync(MSOL_MINT, vaultAuthority, true, TOKEN_PROGRAM_ID);
  const txPre = new Transaction();
  if (!(await connection.getAccountInfo(vaultMsolAta))) {
    txPre.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, vaultMsolAta, vaultAuthority, MSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
    await sendAndConfirmTransaction(connection, txPre, [payer]);
    console.log("  Created vault mSOL ATA:", vaultMsolAta.toBase58());
  } else {
    console.log("  Vault mSOL ATA exists:", vaultMsolAta.toBase58());
  }

  // Check mSOL balance before
  try {
    const before = await connection.getTokenAccountBalance(vaultMsolAta);
    console.log("  mSOL balance before:", before.value.uiAmount);
  } catch { console.log("  mSOL balance before: 0"); }

  // ═══ Deposit to Marinade ═══
  console.log("\n── Deposit to Marinade ──");
  console.log(`  Depositing ${depositLamports / 1e9} SOL to Marinade...`);

  const data = Buffer.alloc(8 + 8);
  disc("deposit_to_marinade").copy(data, 0);
  new BN(depositLamports).toArrayLike(Buffer, "le", 8).copy(data, 8);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    {
      programId: LP_VAULT_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultConfig, isSigner: false, isWritable: false },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        // Marinade accounts
        { pubkey: MARINADE_STATE, isSigner: false, isWritable: true },
        { pubkey: MSOL_MINT, isSigner: false, isWritable: true },
        { pubkey: LIQ_SOL_LEG, isSigner: false, isWritable: true },
        { pubkey: LIQ_POOL_MSOL_LEG, isSigner: false, isWritable: true },
        { pubkey: LIQ_MSOL_AUTH, isSigner: false, isWritable: false },
        { pubkey: RESERVE_PDA, isSigner: false, isWritable: true },
        { pubkey: vaultMsolAta, isSigner: false, isWritable: true },
        { pubkey: MSOL_MINT_AUTH, isSigner: false, isWritable: false },
        { pubkey: MARINADE_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    }
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("✓ Marinade deposit success:", sig.slice(0, 20) + "...");

    // Check mSOL balance after
    const after = await connection.getTokenAccountBalance(vaultMsolAta);
    console.log("  mSOL balance after:", after.value.uiAmount);
    console.log("  mSOL received:", after.value.uiAmount, "mSOL");
  } catch (err: any) {
    console.error("✗ Marinade deposit failed:", err.message?.slice(0, 400));
    if (err.logs) {
      console.log("\n  Program logs:");
      for (const log of err.logs.slice(-10)) console.log("    ", log);
    }
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("MARINADE TEST COMPLETE");
  console.log("═══════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
