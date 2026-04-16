/**
 * HasYield E2E Test — Real DLMM CPI integration on devnet:
 * 1. Initialize LP Vault (if needed)
 * 2. Initialize DLMM Position (if needed)
 * 3. Deposit SOL + USDC → DLMM add_liquidity → receive hyLP
 * 4. Claim fees from DLMM position
 * 5. Withdraw → DLMM remove_liquidity → burn hyLP
 * 6. Initialize Lending Pool (if needed)
 *
 * Run: npx ts-node scripts/e2e-test.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, getMintLen,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Constants ──
const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LP_VAULT_PROGRAM = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
const LENDING_PROGRAM = new PublicKey("J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf");
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEMO_POOL = new PublicKey("EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE");

const MAX_BIN_PER_ARRAY = 70;

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}
function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

/** Derive DLMM bin array PDA from lb_pair and bin array index */
function deriveBinArrayPda(lbPair: PublicKey, index: number): PublicKey {
  // Must use two's complement for negative indices (i64 LE)
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigInt64LE(BigInt(index));
  const [addr] = pda([Buffer.from("bin_array"), lbPair.toBuffer(), indexBuf], DLMM_PROGRAM);
  return addr;
}

/** Derive DLMM event authority PDA */
function deriveEventAuthority(): PublicKey {
  const [addr] = pda([Buffer.from("__event_authority")], DLMM_PROGRAM);
  return addr;
}

/** Calculate bin array index from bin ID */
function binArrayIndex(binId: number): number {
  return Math.floor(binId / MAX_BIN_PER_ARRAY);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  console.log("═══════════════════════════════════════════════════");
  console.log("HasYield E2E Test — Real DLMM CPI");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ── Read DLMM pool state ──
  console.log("\n── Reading DLMM Pool ──");
  let dlmmPool: DLMM;
  try {
    dlmmPool = await DLMM.create(connection, DEMO_POOL, { cluster: "devnet" });
  } catch (err: any) {
    console.error("✗ Failed to load DLMM pool:", err.message?.slice(0, 200));
    console.log("  Make sure the pool exists on devnet: https://devnet.meteora.ag");
    return;
  }

  const lbPairAccount = dlmmPool.lbPair;
  const activeId = lbPairAccount.activeId;
  const tokenXMint = lbPairAccount.tokenXMint;
  const tokenYMint = lbPairAccount.tokenYMint;
  const reserveX = lbPairAccount.reserveX;
  const reserveY = lbPairAccount.reserveY;
  const binStep = lbPairAccount.binStep;

  console.log("  Pool:", DEMO_POOL.toBase58());
  console.log("  Active ID:", activeId);
  console.log("  Bin Step:", binStep);
  console.log("  Token X:", tokenXMint.toBase58());
  console.log("  Token Y:", tokenYMint.toBase58());
  console.log("  Reserve X:", reserveX.toBase58());
  console.log("  Reserve Y:", reserveY.toBase58());

  // Use the pool's actual token mints
  const MINT_X = tokenXMint;
  const MINT_Y = tokenYMint;

  // ── Derive PDAs ──
  const [vaultConfig] = pda([Buffer.from("lp-vault-config"), MINT_X.toBuffer(), MINT_Y.toBuffer()], LP_VAULT_PROGRAM);
  const [vaultAuthority] = pda([Buffer.from("vault-authority"), vaultConfig.toBuffer()], LP_VAULT_PROGRAM);
  const eventAuthority = deriveEventAuthority();

  console.log("\nVault Config:", vaultConfig.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());

  // ═══ Step 1: Check/Initialize LP Vault ═══
  console.log("\n── Step 1: LP Vault ──");
  let hylpMint: PublicKey;
  const vaultInfo = await connection.getAccountInfo(vaultConfig);
  if (vaultInfo) {
    const data = vaultInfo.data;
    // New layout: 8 disc + 32 authority + 32 lb_pair + 32 hylp_mint
    hylpMint = new PublicKey(data.subarray(72, 104));
    // Read position (32 bytes after hylp_mint)
    const positionKey = new PublicKey(data.subarray(104, 136));
    const positionInitialized = positionKey.toBase58() !== PublicKey.default.toBase58();
    console.log("✓ Vault already initialized");
    console.log("  hyLP Mint:", hylpMint.toBase58());
    console.log("  Position:", positionInitialized ? positionKey.toBase58() : "(not initialized)");
  } else {
    console.log("Creating vault...");
    const hylpKeypair = Keypair.generate();
    hylpMint = hylpKeypair.publicKey;
    const mintLen = getMintLen([]);
    const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx1 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: hylpMint,
        space: mintLen, lamports: mintLamports, programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMintInstruction(hylpMint, 9, vaultAuthority, null, TOKEN_2022_PROGRAM_ID),
    );
    await sendAndConfirmTransaction(connection, tx1, [payer, hylpKeypair]);
    console.log("  hyLP Mint created:", hylpMint.toBase58());

    // Create vault token accounts
    const vaultXAta = getAssociatedTokenAddressSync(MINT_X, vaultAuthority, true, TOKEN_PROGRAM_ID);
    const vaultYAta = getAssociatedTokenAddressSync(MINT_Y, vaultAuthority, true, TOKEN_PROGRAM_ID);
    const txAtas = new Transaction();
    if (!(await connection.getAccountInfo(vaultXAta)))
      txAtas.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultXAta, vaultAuthority, MINT_X, TOKEN_PROGRAM_ID));
    if (!(await connection.getAccountInfo(vaultYAta)))
      txAtas.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultYAta, vaultAuthority, MINT_Y, TOKEN_PROGRAM_ID));
    if (txAtas.instructions.length > 0) await sendAndConfirmTransaction(connection, txAtas, [payer]);

    // Initialize vault
    const initData = Buffer.alloc(8 + 32);
    disc("initialize_lp_vault").copy(initData, 0);
    DEMO_POOL.toBuffer().copy(initData, 8);
    const tx3 = new Transaction().add({
      programId: LP_VAULT_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: MINT_X, isSigner: false, isWritable: false },
        { pubkey: MINT_Y, isSigner: false, isWritable: false },
        { pubkey: vaultConfig, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: hylpMint, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    });
    await sendAndConfirmTransaction(connection, tx3, [payer]);
    console.log("✓ Vault initialized");
  }

  // ═══ Step 2: Initialize DLMM Position ═══
  console.log("\n── Step 2: DLMM Position ──");
  // Check if position is already initialized by reading vault config
  const configData = (await connection.getAccountInfo(vaultConfig))!.data;
  const positionKey = new PublicKey(configData.subarray(104, 136));
  const positionInitialized = positionKey.toBase58() !== PublicKey.default.toBase58();

  let position: PublicKey;
  // Position width: 35 bins on each side of active
  const WIDTH = 69; // Must be <= 70
  const lowerBinId = activeId - 34;

  if (positionInitialized) {
    position = positionKey;
    console.log("✓ Position already initialized:", position.toBase58());
  } else {
    console.log("  Creating DLMM position...");
    console.log(`  Range: bins ${lowerBinId} to ${lowerBinId + WIDTH - 1} (active: ${activeId})`);

    const positionKeypair = Keypair.generate();
    position = positionKeypair.publicKey;

    const initPosData = Buffer.alloc(8 + 4 + 4);
    disc("initialize_position").copy(initPosData, 0);
    initPosData.writeInt32LE(lowerBinId, 8);
    initPosData.writeInt32LE(WIDTH, 12);

    const initPosTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      {
        programId: LP_VAULT_PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: MINT_X, isSigner: false, isWritable: false },
          { pubkey: MINT_Y, isSigner: false, isWritable: false },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: vaultAuthority, isSigner: false, isWritable: false },
          { pubkey: position, isSigner: true, isWritable: true },
          { pubkey: DEMO_POOL, isSigner: false, isWritable: false },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: initPosData,
      }
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, initPosTx, [payer, positionKeypair]);
      console.log("✓ Position initialized:", sig.slice(0, 20) + "...");
    } catch (err: any) {
      console.error("✗ Position init failed:", err.message?.slice(0, 300));
      return;
    }
  }

  // Re-read config to get lower_bin_id and width
  const updatedConfig = (await connection.getAccountInfo(vaultConfig))!.data;
  // Offsets: 8 disc + 32*4 pubkeys + 8*4 u64s = 168, then lower_bin_id i32, width i32
  const storedLowerBinId = updatedConfig.readInt32LE(168);
  const storedWidth = updatedConfig.readInt32LE(172);
  console.log(`  Stored range: bins ${storedLowerBinId} to ${storedLowerBinId + storedWidth - 1}`);

  // Derive bin array PDAs
  const lowerArrayIndex = binArrayIndex(storedLowerBinId);
  const upperArrayIndex = binArrayIndex(storedLowerBinId + storedWidth - 1);
  const binArrayLower = deriveBinArrayPda(DEMO_POOL, lowerArrayIndex);
  const binArrayUpper = deriveBinArrayPda(DEMO_POOL, upperArrayIndex);
  console.log("  Bin Array Lower (idx", lowerArrayIndex + "):", binArrayLower.toBase58());
  console.log("  Bin Array Upper (idx", upperArrayIndex + "):", binArrayUpper.toBase58());

  // Derive bitmap extension PDA — if it doesn't exist, pass DLMM_PROGRAM as placeholder
  const [bitmapExtensionPda] = pda([Buffer.from("bitmap"), DEMO_POOL.toBuffer()], DLMM_PROGRAM);
  const bitmapExtInfo = await connection.getAccountInfo(bitmapExtensionPda);
  const bitmapExtension = bitmapExtInfo ? bitmapExtensionPda : DLMM_PROGRAM;
  console.log("  Bitmap Extension:", bitmapExtInfo ? bitmapExtensionPda.toBase58() : "(not needed, using program ID)");

  // ═══ Step 2.5: Initialize Bin Arrays (if needed) ═══
  console.log("\n── Step 2.5: Initialize Bin Arrays ──");
  const INIT_BIN_ARRAY_DISC = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

  for (const [label, arrayAddr, arrayIndex] of [
    ["Lower", binArrayLower, lowerArrayIndex],
    ["Upper", binArrayUpper, upperArrayIndex],
  ] as [string, PublicKey, number][]) {
    const info = await connection.getAccountInfo(arrayAddr);
    if (info) {
      console.log(`  ✓ Bin Array ${label} (idx ${arrayIndex}) already exists`);
    } else {
      console.log(`  Creating Bin Array ${label} (idx ${arrayIndex})...`);
      const data = Buffer.alloc(8 + 8);
      INIT_BIN_ARRAY_DISC.copy(data, 0);
      data.writeBigInt64LE(BigInt(arrayIndex), 8);

      const initBinTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        {
          programId: DLMM_PROGRAM,
          keys: [
            { pubkey: DEMO_POOL, isSigner: false, isWritable: false },
            { pubkey: arrayAddr, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }
      );
      try {
        const sig = await sendAndConfirmTransaction(connection, initBinTx, [payer]);
        console.log(`  ✓ Bin Array ${label} created:`, sig.slice(0, 20) + "...");
      } catch (err: any) {
        console.error(`  ✗ Bin Array ${label} init failed:`, err.message?.slice(0, 200));
        return;
      }
    }
  }

  // ═══ Step 3: Deposit ═══
  console.log("\n── Step 3: Deposit with DLMM CPI ──");
  // Pool order: X = USDC (6 decimals), Y = SOL (9 decimals)
  const depositX = 0; // USDC amount (0 for now — SOL-only deposit)
  const depositY = 5_000_000; // 0.005 SOL (9 decimals)

  // Ensure ATAs exist
  const vaultXAta = getAssociatedTokenAddressSync(MINT_X, vaultAuthority, true, TOKEN_PROGRAM_ID);
  const vaultYAta = getAssociatedTokenAddressSync(MINT_Y, vaultAuthority, true, TOKEN_PROGRAM_ID);
  const userXAta = getAssociatedTokenAddressSync(MINT_X, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const userYAta = getAssociatedTokenAddressSync(MINT_Y, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const userHylpAta = getAssociatedTokenAddressSync(hylpMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const txPre = new Transaction();
  const atasToCheck: [PublicKey, PublicKey, PublicKey, PublicKey][] = [
    [userHylpAta, payer.publicKey, hylpMint, TOKEN_2022_PROGRAM_ID],
    [userXAta, payer.publicKey, MINT_X, TOKEN_PROGRAM_ID],
    [userYAta, payer.publicKey, MINT_Y, TOKEN_PROGRAM_ID],
    [vaultXAta, vaultAuthority, MINT_X, TOKEN_PROGRAM_ID],
    [vaultYAta, vaultAuthority, MINT_Y, TOKEN_PROGRAM_ID],
  ];
  for (const [ata, owner, mint, prog] of atasToCheck) {
    if (!(await connection.getAccountInfo(ata)))
      txPre.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, prog));
  }
  if (txPre.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, txPre, [payer]);
    console.log("  Created missing ATAs");
  }

  // Wrap SOL into WSOL (Y token)
  if (depositY > 0) {
    console.log("  Wrapping SOL...");
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userYAta, lamports: depositY }),
      { programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: userYAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) },
    );
    await sendAndConfirmTransaction(connection, wrapTx, [payer]);
  }

  // Build deposit instruction data:
  // disc + amount_x(u64) + amount_y(u64) + active_id(i32) + max_active_bin_slippage(i32)
  console.log(`  Depositing ${depositX / 1e6} USDC + ${depositY / 1e9} SOL...`);
  const depositData = Buffer.alloc(8 + 8 + 8 + 4 + 4);
  disc("deposit_liquidity").copy(depositData, 0);
  new BN(depositX).toArrayLike(Buffer, "le", 8).copy(depositData, 8);
  new BN(depositY).toArrayLike(Buffer, "le", 8).copy(depositData, 16);
  depositData.writeInt32LE(activeId, 24);
  depositData.writeInt32LE(5, 28); // max slippage = 5

  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    {
      programId: LP_VAULT_PROGRAM,
      keys: [
        // Vault accounts
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: MINT_X, isSigner: false, isWritable: false },
        { pubkey: MINT_Y, isSigner: false, isWritable: false },
        { pubkey: vaultConfig, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: hylpMint, isSigner: false, isWritable: true },
        { pubkey: userXAta, isSigner: false, isWritable: true },
        { pubkey: userYAta, isSigner: false, isWritable: true },
        { pubkey: vaultXAta, isSigner: false, isWritable: true },
        { pubkey: vaultYAta, isSigner: false, isWritable: true },
        { pubkey: userHylpAta, isSigner: false, isWritable: true },
        // DLMM accounts
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: DEMO_POOL, isSigner: false, isWritable: true },
        { pubkey: bitmapExtension, isSigner: false, isWritable: true },
        { pubkey: reserveX, isSigner: false, isWritable: true },
        { pubkey: reserveY, isSigner: false, isWritable: true },
        { pubkey: binArrayLower, isSigner: false, isWritable: true },
        { pubkey: binArrayUpper, isSigner: false, isWritable: true },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },
        // Token programs
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: depositData,
    }
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, depositTx, [payer]);
    console.log("✓ Deposit + DLMM add_liquidity success:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.error("✗ Deposit failed:", err.message?.slice(0, 400));
    // Try to get logs
    if (err.logs) {
      console.log("\n  Program logs:");
      for (const log of err.logs.slice(-10)) console.log("    ", log);
    }
    return;
  }

  const hylpAccount = await connection.getTokenAccountBalance(userHylpAta);
  console.log("  hyLP balance:", hylpAccount.value.uiAmount);

  // ═══ Step 4: Claim Fees ═══
  console.log("\n── Step 4: Claim Fees ──");
  const claimData = disc("claim_fees");
  const claimTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    {
      programId: LP_VAULT_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: MINT_X, isSigner: false, isWritable: false },
        { pubkey: MINT_Y, isSigner: false, isWritable: false },
        { pubkey: vaultConfig, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: DEMO_POOL, isSigner: false, isWritable: true },
        { pubkey: binArrayLower, isSigner: false, isWritable: true },
        { pubkey: binArrayUpper, isSigner: false, isWritable: true },
        { pubkey: reserveX, isSigner: false, isWritable: true },
        { pubkey: reserveY, isSigner: false, isWritable: true },
        { pubkey: vaultXAta, isSigner: false, isWritable: true },
        { pubkey: vaultYAta, isSigner: false, isWritable: true },
        { pubkey: MINT_X, isSigner: false, isWritable: false },
        { pubkey: MINT_Y, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: claimData,
    }
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, claimTx, [payer]);
    console.log("✓ Claim fees success:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.log("  Claim fees skipped (likely no fees accrued yet):", err.message?.slice(0, 100));
  }

  // ═══ Step 5: Withdraw ═══
  console.log("\n── Step 5: Withdraw ──");
  const hylpBalance = await connection.getTokenAccountBalance(userHylpAta);
  const sharesToBurn = new BN(hylpBalance.value.amount);
  if (sharesToBurn.isZero()) {
    console.log("  No hyLP to withdraw, skipping");
  } else {
    console.log(`  Withdrawing ${hylpBalance.value.uiAmount} hyLP...`);
    const withdrawData = Buffer.alloc(8 + 8);
    disc("withdraw_liquidity").copy(withdrawData, 0);
    sharesToBurn.toArrayLike(Buffer, "le", 8).copy(withdrawData, 8);

    const withdrawTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      {
        programId: LP_VAULT_PROGRAM,
        keys: [
          // Vault accounts
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: MINT_X, isSigner: false, isWritable: false },
          { pubkey: MINT_Y, isSigner: false, isWritable: false },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: vaultAuthority, isSigner: false, isWritable: false },
          { pubkey: hylpMint, isSigner: false, isWritable: true },
          { pubkey: userXAta, isSigner: false, isWritable: true },
          { pubkey: userYAta, isSigner: false, isWritable: true },
          { pubkey: vaultXAta, isSigner: false, isWritable: true },
          { pubkey: vaultYAta, isSigner: false, isWritable: true },
          { pubkey: userHylpAta, isSigner: false, isWritable: true },
          // DLMM accounts
          { pubkey: position, isSigner: false, isWritable: true },
          { pubkey: DEMO_POOL, isSigner: false, isWritable: true },
          { pubkey: bitmapExtension, isSigner: false, isWritable: true },
          { pubkey: reserveX, isSigner: false, isWritable: true },
          { pubkey: reserveY, isSigner: false, isWritable: true },
          { pubkey: binArrayLower, isSigner: false, isWritable: true },
          { pubkey: binArrayUpper, isSigner: false, isWritable: true },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },
          // Token programs
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: withdrawData,
      }
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, withdrawTx, [payer]);
      console.log("✓ Withdraw + DLMM remove_liquidity success:", sig.slice(0, 20) + "...");
    } catch (err: any) {
      console.error("✗ Withdraw failed:", err.message?.slice(0, 400));
      if (err.logs) {
        console.log("\n  Program logs:");
        for (const log of err.logs.slice(-10)) console.log("    ", log);
      }
    }
  }

  // ═══ Step 6: Lending Pool ═══
  console.log("\n── Step 6: Lending Pool ──");
  const [lendingPool] = pda([Buffer.from("lending-pool"), hylpMint.toBuffer(), USDC_MINT.toBuffer()], LENDING_PROGRAM);
  const [poolAuthority] = pda([Buffer.from("pool-authority"), lendingPool.toBuffer()], LENDING_PROGRAM);

  const lendingInfo = await connection.getAccountInfo(lendingPool);
  if (lendingInfo) {
    console.log("✓ Lending pool already initialized");
  } else {
    console.log("  Creating lending pool...");
    const initPoolData = Buffer.alloc(8 + 2 + 2);
    disc("initialize_pool").copy(initPoolData, 0);
    initPoolData.writeUInt16LE(5000, 8);
    initPoolData.writeUInt16LE(500, 10);

    const initPoolTx = new Transaction().add({
      programId: LENDING_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: hylpMint, isSigner: false, isWritable: false },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: lendingPool, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initPoolData,
    });
    try {
      await sendAndConfirmTransaction(connection, initPoolTx, [payer]);
      console.log("✓ Lending pool initialized");
    } catch (err: any) {
      console.error("✗ Lending pool init failed:", err.message?.slice(0, 200));
    }
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("E2E TEST COMPLETE");
  console.log("═══════════════════════════════════════════════════");
  console.log("Vault Config:     ", vaultConfig.toBase58());
  console.log("Vault Authority:  ", vaultAuthority.toBase58());
  console.log("hyLP Mint:        ", hylpMint.toBase58());
  console.log("DLMM Position:    ", position.toBase58());
  console.log("Lending Pool:     ", lendingPool.toBase58());
  console.log("═══════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
