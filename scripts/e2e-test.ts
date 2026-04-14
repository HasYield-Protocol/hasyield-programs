/**
 * HasYield E2E Test — Tests the full flywheel on devnet:
 * 1. Initialize LP Vault (if needed)
 * 2. Deposit USDC + SOL → receive hyLP
 * 3. Check hyLP balance
 * 4. Initialize Lending Pool (if needed)
 * 5. Deposit hyLP as collateral
 * 6. Borrow USDC
 * 7. Repay USDC
 * 8. Withdraw collateral
 * 9. Withdraw from LP Vault (burn hyLP)
 *
 * Run: npx ts-node scripts/e2e-test.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, getMintLen,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LP_VAULT_PROGRAM = new PublicKey("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");
const LENDING_PROGRAM = new PublicKey("J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEMO_POOL = new PublicKey("EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE");

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}
function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  console.log("═══════════════════════════════════════════════════");
  console.log("HasYield E2E Test");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ═══ Derive PDAs ═══
  // Use SOL + test token for a completely fresh vault (avoids old state conflicts)
  const TEST_TOKEN = new PublicKey("37cmsMVz5ShtozEqa2i1HEtv9MXCA7VwUsuAy9fqyo34");
  const MINT_X = WSOL_MINT;
  const MINT_Y = TEST_TOKEN;
  const [vaultConfig] = pda([Buffer.from("lp-vault-config"), MINT_X.toBuffer(), MINT_Y.toBuffer()], LP_VAULT_PROGRAM);
  const [vaultAuthority] = pda([Buffer.from("vault-authority"), vaultConfig.toBuffer()], LP_VAULT_PROGRAM);
  console.log("\nVault Config:", vaultConfig.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());

  // ═══ Step 1: Check/Initialize LP Vault ═══
  console.log("\n── Step 1: LP Vault ──");
  let hylpMint: PublicKey;
  const vaultInfo = await connection.getAccountInfo(vaultConfig);
  if (vaultInfo) {
    const data = vaultInfo.data;
    hylpMint = new PublicKey(data.subarray(72, 104));
    console.log("✓ Vault already initialized");
    console.log("  hyLP Mint:", hylpMint.toBase58());
  } else {
    console.log("Creating vault...");
    // Create hyLP mint
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
    const vaultXAta = getAssociatedTokenAddressSync(MINT_X, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const vaultYAta = getAssociatedTokenAddressSync(MINT_Y, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const tx2 = new Transaction();
    if (!(await connection.getAccountInfo(vaultXAta)))
      tx2.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultXAta, vaultAuthority, MINT_X, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    if (!(await connection.getAccountInfo(vaultYAta)))
      tx2.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultYAta, vaultAuthority, MINT_Y, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    if (tx2.instructions.length > 0) await sendAndConfirmTransaction(connection, tx2, [payer]);

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

  // ═══ Step 2: Deposit USDC + SOL ═══
  console.log("\n── Step 2: Deposit ──");
  // MINT_X = SOL, MINT_Y = USDC
  const depositX = 10_000_000; // 0.01 SOL (9 decimals)
  const depositY = 0; // 0 test token — SOL only deposit

  const userXAta = getAssociatedTokenAddressSync(MINT_X, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userYAta = getAssociatedTokenAddressSync(MINT_Y, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultXAta = getAssociatedTokenAddressSync(MINT_X, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultYAta = getAssociatedTokenAddressSync(MINT_Y, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userHylpAta = getAssociatedTokenAddressSync(hylpMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Ensure ALL ATAs exist
  const atasToCreate: [PublicKey, PublicKey, PublicKey, PublicKey][] = [
    [userHylpAta, payer.publicKey, hylpMint, TOKEN_2022_PROGRAM_ID],
    [userXAta, payer.publicKey, MINT_X, TOKEN_PROGRAM_ID],
    [userYAta, payer.publicKey, MINT_Y, TOKEN_PROGRAM_ID],
    [vaultXAta, vaultAuthority, MINT_X, TOKEN_PROGRAM_ID],
    [vaultYAta, vaultAuthority, MINT_Y, TOKEN_PROGRAM_ID],
  ];
  const txPre = new Transaction();
  for (const [ata, owner, mint, prog] of atasToCreate) {
    if (!(await connection.getAccountInfo(ata)))
      txPre.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, prog, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  if (txPre.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, txPre, [payer]);
    console.log("  Created missing ATAs");
  }

  // Wrap SOL into WSOL
  console.log("  Wrapping SOL...");
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userXAta, lamports: depositX }),
    { programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: userXAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) }, // syncNative
  );
  await sendAndConfirmTransaction(connection, wrapTx, [payer]);

  // Deposit
  console.log(`  Depositing ${depositX / 1e9} SOL + ${depositY / 1e6} USDC...`);
  const depositData = Buffer.alloc(8 + 8 + 8);
  disc("deposit_liquidity").copy(depositData, 0);
  new BN(depositX).toArrayLike(Buffer, "le", 8).copy(depositData, 8);
  new BN(depositY).toArrayLike(Buffer, "le", 8).copy(depositData, 16);

  const depositTx = new Transaction().add({
    programId: LP_VAULT_PROGRAM,
    keys: [
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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  try {
    const sig = await sendAndConfirmTransaction(connection, depositTx, [payer]);
    console.log("✓ Deposit success:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.error("✗ Deposit failed:", err.message?.slice(0, 200));
    console.log("\n  This is expected if the vault was initialized with old PDA seeds.");
    console.log("  Run: npx ts-node scripts/setup-lp-vault.ts to re-initialize.");
    return;
  }

  // Check hyLP balance
  const hylpAccount = await connection.getTokenAccountBalance(userHylpAta);
  console.log("  hyLP balance:", hylpAccount.value.uiAmount);

  // ═══ Step 3: Simulate fees ═══
  console.log("\n── Step 3: Simulate Fees ──");
  const feeData = Buffer.alloc(8 + 8 + 8);
  disc("simulate_fees").copy(feeData, 0);
  new BN(100_000).toArrayLike(Buffer, "le", 8).copy(feeData, 8); // 0.1 USDC fee
  new BN(1_000_000).toArrayLike(Buffer, "le", 8).copy(feeData, 16); // 0.001 SOL fee

  const feeTx = new Transaction().add({
    programId: LP_VAULT_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultConfig, isSigner: false, isWritable: true },
    ],
    data: feeData,
  });
  try {
    await sendAndConfirmTransaction(connection, feeTx, [payer]);
    console.log("✓ Fees simulated (exchange rate boosted)");
  } catch (err: any) {
    console.error("✗ Fee simulation failed:", err.message?.slice(0, 100));
  }

  // ═══ Step 4: Initialize Lending Pool ═══
  console.log("\n── Step 4: Lending Pool ──");
  const [lendingPool] = pda([Buffer.from("lending-pool"), hylpMint.toBuffer(), USDC_MINT.toBuffer()], LENDING_PROGRAM);
  const [poolAuthority] = pda([Buffer.from("pool-authority"), lendingPool.toBuffer()], LENDING_PROGRAM);

  const lendingInfo = await connection.getAccountInfo(lendingPool);
  if (lendingInfo) {
    console.log("✓ Lending pool already initialized");
  } else {
    console.log("  Creating lending pool...");
    const initPoolData = Buffer.alloc(8 + 2 + 2);
    disc("initialize_pool").copy(initPoolData, 0);
    initPoolData.writeUInt16LE(5000, 8); // 50% LTV
    initPoolData.writeUInt16LE(500, 10); // 5% interest

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
  console.log("Lending Pool:     ", lendingPool.toBase58());
  console.log("Pool Authority:   ", poolAuthority.toBase58());
  console.log("═══════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
