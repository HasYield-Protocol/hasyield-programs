/**
 * Seed the HasYield lending pool with USDC liquidity so borrowing works.
 * Creates a test USDC mint we control, initializes a lending pool, and deposits liquidity.
 *
 * Run: ts-node scripts/seed-lending-pool.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction, getMintLen,
  createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const LENDING_PROGRAM = new PublicKey("J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf");
const HYLP_MINT = new PublicKey("58WoS25fsv2Pod6LkcuvrsF5p19YFfavmaAJAjRuvvMF");

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  console.log("═══════════════════════════════════════════════════");
  console.log("Seed HasYield Lending Pool with USDC Liquidity");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ═══ Step 1: Create test USDC mint ═══
  console.log("\n── Step 1: Create Test USDC ──");
  const usdcKeypair = Keypair.generate();
  const usdcMint = usdcKeypair.publicKey;
  const mintLen = getMintLen([]);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: usdcMint,
      space: mintLen, lamports: mintLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(usdcMint, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [payer, usdcKeypair]);
  console.log("  Test USDC mint:", usdcMint.toBase58());

  // Mint 10,000 USDC to payer
  const payerUsdcAta = getAssociatedTokenAddressSync(usdcMint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const mintTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, payerUsdcAta, payer.publicKey, usdcMint, TOKEN_PROGRAM_ID),
    {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: usdcMint, isSigner: false, isWritable: true },
        { pubkey: payerUsdcAta, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([7]), new BN(10_000_000_000).toArrayLike(Buffer, "le", 8)]),
    },
  );
  await sendAndConfirmTransaction(connection, mintTx, [payer]);
  console.log("  Minted 10,000 USDC to:", payerUsdcAta.toBase58());

  // ═══ Step 2: Initialize lending pool (hyLP collateral, test USDC borrow) ═══
  console.log("\n── Step 2: Initialize Lending Pool ──");
  const [lendingPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending-pool"), HYLP_MINT.toBuffer(), usdcMint.toBuffer()],
    LENDING_PROGRAM
  );
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), lendingPool.toBuffer()],
    LENDING_PROGRAM
  );

  const poolInfo = await connection.getAccountInfo(lendingPool);
  if (poolInfo) {
    console.log("  Pool already exists:", lendingPool.toBase58());
  } else {
    const initPoolData = Buffer.alloc(8 + 2 + 2);
    disc("initialize_pool").copy(initPoolData, 0);
    initPoolData.writeUInt16LE(5000, 8); // 50% LTV
    initPoolData.writeUInt16LE(500, 10); // 5% interest

    const initPoolTx = new Transaction().add({
      programId: LENDING_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: HYLP_MINT, isSigner: false, isWritable: false },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: lendingPool, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initPoolData,
    });
    await sendAndConfirmTransaction(connection, initPoolTx, [payer]);
    console.log("✓ Pool initialized:", lendingPool.toBase58());
  }

  // ═══ Step 3: Create pool borrow token account and deposit liquidity ═══
  console.log("\n── Step 3: Deposit Borrow Liquidity ──");
  const poolBorrowAta = getAssociatedTokenAddressSync(usdcMint, poolAuthority, true, TOKEN_PROGRAM_ID);

  const prepTx = new Transaction();
  if (!(await connection.getAccountInfo(poolBorrowAta))) {
    prepTx.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, poolBorrowAta, poolAuthority, usdcMint, TOKEN_PROGRAM_ID
    ));
  }
  // Also create pool collateral ATA for hyLP (Token-2022)
  const poolCollateralAta = getAssociatedTokenAddressSync(HYLP_MINT, poolAuthority, true, TOKEN_2022_PROGRAM_ID);
  if (!(await connection.getAccountInfo(poolCollateralAta))) {
    prepTx.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, poolCollateralAta, poolAuthority, HYLP_MINT, TOKEN_2022_PROGRAM_ID
    ));
  }
  if (prepTx.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, prepTx, [payer]);
    console.log("  Created pool ATAs");
  }

  // Deposit 5,000 USDC as borrow liquidity
  const depositAmount = 5_000_000_000; // 5000 USDC (6 decimals)
  const depositData = Buffer.alloc(8 + 8);
  disc("deposit_borrow_liquidity").copy(depositData, 0);
  new BN(depositAmount).toArrayLike(Buffer, "le", 8).copy(depositData, 8);

  const depositTx = new Transaction().add({
    programId: LENDING_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: lendingPool, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: payerUsdcAta, isSigner: false, isWritable: true },
      { pubkey: poolBorrowAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  try {
    await sendAndConfirmTransaction(connection, depositTx, [payer]);
    console.log("✓ Deposited 5,000 USDC as borrow liquidity");
  } catch (err: any) {
    console.error("✗ Deposit failed:", err.message?.slice(0, 300));
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log("  ", l));
  }

  // ═══ Output ═══
  console.log("\n═══════════════════════════════════════════════════");
  console.log("LENDING POOL SEEDED");
  console.log("═══════════════════════════════════════════════════");
  console.log("Test USDC Mint:     ", usdcMint.toBase58());
  console.log("Lending Pool:       ", lendingPool.toBase58());
  console.log("Pool Authority:     ", poolAuthority.toBase58());
  console.log("Pool Borrow ATA:    ", poolBorrowAta.toBase58());
  console.log("Pool Collateral ATA:", poolCollateralAta.toBase58());
  console.log("hyLP Mint:          ", HYLP_MINT.toBase58());
  console.log("═══════════════════════════════════════════════════");
  console.log("\nUpdate lp-constants.ts with these addresses for frontend.");
  console.log("The lending pool now has 5,000 USDC for borrowing.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
