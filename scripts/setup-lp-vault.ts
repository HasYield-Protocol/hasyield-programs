/**
 * Setup LP Vault on devnet:
 * 1. Create hyLP mint (Token-2022) with vault authority as mint authority
 * 2. Initialize LP vault config
 * 3. Create vault token accounts for USDC + SOL
 *
 * Run: npx ts-node scripts/setup-lp-vault.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LP_VAULT_PROGRAM_ID = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEMO_POOL = new PublicKey("EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE");

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");

  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // Derive PDAs
  const [vaultConfig] = findPda(
    [Buffer.from("lp-vault-config"), USDC_MINT.toBuffer(), WSOL_MINT.toBuffer()],
    LP_VAULT_PROGRAM_ID,
  );
  console.log("Vault Config PDA:", vaultConfig.toBase58());

  // Check if already initialized
  const existing = await connection.getAccountInfo(vaultConfig);
  if (existing) {
    console.log("Vault already initialized! Reading config...");
    const data = existing.data;
    const authority = new PublicKey(data.subarray(8, 40));
    const lbPair = new PublicKey(data.subarray(40, 72));
    const hylpMint = new PublicKey(data.subarray(72, 104));
    console.log("  Authority:", authority.toBase58());
    console.log("  LB Pair:", lbPair.toBase58());
    console.log("  hyLP Mint:", hylpMint.toBase58());
    writeConstants(vaultConfig, hylpMint);
    return;
  }

  // We need vault authority PDA — but it depends on vault_config which isn't created yet
  // The vault_config key is deterministic, so we can derive vault_authority from it
  const [vaultAuthority, vaultAuthorityBump] = findPda(
    [Buffer.from("vault-authority"), vaultConfig.toBuffer()],
    LP_VAULT_PROGRAM_ID,
  );
  console.log("Vault Authority PDA:", vaultAuthority.toBase58());

  // Step 1: Create hyLP mint (Token-2022), authority = vaultAuthority
  console.log("\nCreating hyLP mint...");
  const hylpMintKeypair = Keypair.generate();
  const mintLen = getMintLen([]);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx1 = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: hylpMintKeypair.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      hylpMintKeypair.publicKey, 9, vaultAuthority, null, TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, tx1, [payer, hylpMintKeypair]);
  console.log("hyLP Mint:", hylpMintKeypair.publicKey.toBase58());

  // Step 2: Create vault token accounts (USDC + WSOL ATAs owned by vault authority)
  console.log("Creating vault token accounts...");
  const vaultUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const vaultWsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tx2 = new Transaction();
  // Check if ATAs exist
  if (!(await connection.getAccountInfo(vaultUsdcAta))) {
    tx2.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, vaultUsdcAta, vaultAuthority, USDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  if (!(await connection.getAccountInfo(vaultWsolAta))) {
    tx2.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, vaultWsolAta, vaultAuthority, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  if (tx2.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, tx2, [payer]);
    console.log("Vault USDC ATA:", vaultUsdcAta.toBase58());
    console.log("Vault WSOL ATA:", vaultWsolAta.toBase58());
  }

  // Step 3: Initialize LP Vault
  console.log("Initializing LP vault...");
  const initData = Buffer.alloc(8 + 32);
  disc("initialize_lp_vault").copy(initData, 0);
  DEMO_POOL.toBuffer().copy(initData, 8);

  const tx3 = new Transaction().add({
    programId: LP_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultConfig, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: hylpMintKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  try {
    await sendAndConfirmTransaction(connection, tx3, [payer]);
    console.log("LP Vault initialized!");
  } catch (err) {
    console.error("Init failed:", (err as Error).message?.slice(0, 200));
  }

  // Output
  console.log("\n" + "═".repeat(60));
  console.log("LP VAULT SETUP COMPLETE");
  console.log("═".repeat(60));
  console.log("Vault Config:    ", vaultConfig.toBase58());
  console.log("Vault Authority: ", vaultAuthority.toBase58());
  console.log("hyLP Mint:       ", hylpMintKeypair.publicKey.toBase58());
  console.log("Vault USDC ATA:  ", vaultUsdcAta.toBase58());
  console.log("Vault WSOL ATA:  ", vaultWsolAta.toBase58());
  console.log("DLMM Pool:       ", DEMO_POOL.toBase58());
  console.log("═".repeat(60));

  writeConstants(vaultConfig, hylpMintKeypair.publicKey);
}

function writeConstants(vaultConfig: PublicKey, hylpMint: PublicKey) {
  const content = `import { PublicKey } from "@solana/web3.js";

// Meteora DLMM
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DEMO_POOL_ADDRESS = new PublicKey("EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE");

// Token mints
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_DEVNET_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// HasYield programs
export const LP_VAULT_PROGRAM_ID = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
export const LENDING_PROGRAM_ID = new PublicKey("J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf");

// Vault state (from setup script)
export const LP_VAULT_CONFIG = new PublicKey("${vaultConfig.toBase58()}");
export const HYLP_MINT = new PublicKey("${hylpMint.toBase58()}");
`;

  const outPath = path.join(__dirname, "..", "frontend", "src", "lib", "lp-constants.ts");
  fs.writeFileSync(outPath, content);
  console.log(`\nConstants updated: ${outPath}`);
}

main().catch(console.error);
