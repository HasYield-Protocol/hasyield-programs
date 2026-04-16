/**
 * Setup Solend devnet lending market + USDC reserve for HasYield.
 * Creates a market we own, then adds a reserve for our USDC mint.
 *
 * Run: ts-node scripts/setup-solend.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createInitializeMintInstruction, createInitializeAccountInstruction,
  getMintLen, getAccountLen, createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://devnet.helius-rpc.com/?api-key=564aed68-fda0-4c81-a63c-eab043f99fb6";
const SOLEND_PROGRAM = new PublicKey("ALend7Ketfx5bxh6ghsCDXAoDrhvEmsXT3cynB6aPLgx");
// We'll create our own test USDC mint since we can't mint the shared devnet USDC
let USDC_MINT: PublicKey;

// Pyth devnet oracle program
const PYTH_PROGRAM = new PublicKey("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");
// Switchboard v2 devnet
const SWITCHBOARD_PROGRAM = new PublicKey("2TfB33aLaneQb5TNVwyDz3jSZXS6jdW2ARw1Dgf84XCG");

// Solend's NULL_PUBKEY constant
const NULL_PUBKEY = new PublicKey(Buffer.from([
  11, 193, 238, 216, 208, 116, 241, 195, 55, 212, 76, 22,
  75, 202, 40, 216, 76, 206, 27, 169, 138, 64, 177, 28,
  19, 90, 156, 0, 0, 0, 0, 0
]));

// Pyth devnet USDC/USD price feeds
const PYTH_USDC_PRODUCT = new PublicKey("6NpdXrQEpmDZ3jDMPNfERjyGLNuALiE5yPyJFRga5eDK");
const PYTH_USDC_PRICE = new PublicKey("5SSkXsEKFhXQTaxhVoP96YGsPREnt5DdW92EGvhCJTgR");

const MARKET_SIZE = 290;
const RESERVE_SIZE = 619;

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  console.log("═══════════════════════════════════════════════════");
  console.log("Solend Devnet Setup — HasYield USDC Reserve");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // ═══ Step 0: Create our own USDC-like mint ═══
  console.log("\n── Step 0: Create Test USDC Mint ──");
  const usdcKeypair = Keypair.generate();
  USDC_MINT = usdcKeypair.publicKey;
  const usdcMintLamports = await connection.getMinimumBalanceForRentExemption(getMintLen([]));

  const createUsdcTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: USDC_MINT,
      space: getMintLen([]), lamports: usdcMintLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(USDC_MINT, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createUsdcTx, [payer, usdcKeypair]);
  console.log("  Test USDC mint:", USDC_MINT.toBase58());

  // Create ATA and mint some USDC to ourselves
  const payerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const mintUsdcTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, payerUsdcAta, payer.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    // MintTo instruction: opcode 7, amount u64
    {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: USDC_MINT, isSigner: false, isWritable: true },
        { pubkey: payerUsdcAta, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([7]), new BN(1_000_000_000).toArrayLike(Buffer, "le", 8)]), // 1000 USDC
    },
  );
  await sendAndConfirmTransaction(connection, mintUsdcTx, [payer]);
  console.log("  Minted 1000 test USDC to:", payerUsdcAta.toBase58());

  // Check if Pyth oracle exists on devnet
  const pythInfo = await connection.getAccountInfo(PYTH_USDC_PRICE);
  console.log("Pyth USDC/USD price feed exists:", !!pythInfo);
  if (!pythInfo) {
    console.log("WARNING: Pyth oracle not found. Will try with Switchboard NULL fallback.");
  }

  // ═══ Step 1: Create Lending Market ═══
  console.log("\n── Step 1: Create Lending Market ──");
  const marketKeypair = Keypair.generate();
  const marketPubkey = marketKeypair.publicKey;
  const marketLamports = await connection.getMinimumBalanceForRentExemption(MARKET_SIZE);

  // Derive market authority PDA
  const [marketAuthority] = PublicKey.findProgramAddressSync(
    [marketPubkey.toBuffer()], SOLEND_PROGRAM
  );
  console.log("  Market:", marketPubkey.toBase58());
  console.log("  Market Authority PDA:", marketAuthority.toBase58());

  // Create market account
  const createMarketTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: marketPubkey,
      space: MARKET_SIZE,
      lamports: marketLamports,
      programId: SOLEND_PROGRAM,
    })
  );

  // InitLendingMarket: tag 0 + owner(32) + quote_currency(32) = 65 bytes
  const initMarketData = Buffer.alloc(65);
  initMarketData.writeUInt8(0, 0); // tag
  payer.publicKey.toBuffer().copy(initMarketData, 1); // owner
  Buffer.from("USD\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").copy(initMarketData, 33);

  createMarketTx.add({
    programId: SOLEND_PROGRAM,
    keys: [
      { pubkey: marketPubkey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PYTH_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SWITCHBOARD_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: initMarketData,
  });

  try {
    const sig = await sendAndConfirmTransaction(connection, createMarketTx, [payer, marketKeypair]);
    console.log("✓ Lending market created:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.error("✗ Market creation failed:", err.message?.slice(0, 300));
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log("  ", l));
    return;
  }

  // ═══ Step 2: Create Reserve Accounts ═══
  console.log("\n── Step 2: Create Reserve Token Accounts ──");

  const reserveKeypair = Keypair.generate();
  const collateralMintKeypair = Keypair.generate();
  const liquiditySupplyKeypair = Keypair.generate();
  const feeReceiverKeypair = Keypair.generate();
  const collateralSupplyKeypair = Keypair.generate();

  const reserveLamports = await connection.getMinimumBalanceForRentExemption(RESERVE_SIZE);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(getMintLen([]));
  const tokenLamports = await connection.getMinimumBalanceForRentExemption(getAccountLen([]));

  // Create reserve account (owned by Solend program)
  // Create collateral mint (authority = market authority PDA)
  // Create liquidity supply token account (authority = market authority PDA)
  // Create fee receiver token account (authority = market authority PDA)
  // Create collateral supply token account (authority = market authority PDA)

  const createAccountsTx = new Transaction();

  // Reserve account
  createAccountsTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: reserveKeypair.publicKey,
    space: RESERVE_SIZE, lamports: reserveLamports, programId: SOLEND_PROGRAM,
  }));

  // Collateral mint (cToken)
  createAccountsTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: collateralMintKeypair.publicKey,
      space: getMintLen([]), lamports: mintLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(collateralMintKeypair.publicKey, 9, marketAuthority, null, TOKEN_PROGRAM_ID),
  );

  // Liquidity supply token account (holds USDC deposits)
  createAccountsTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: liquiditySupplyKeypair.publicKey,
      space: getAccountLen([]), lamports: tokenLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(liquiditySupplyKeypair.publicKey, USDC_MINT, marketAuthority, TOKEN_PROGRAM_ID),
  );

  // Fee receiver token account
  createAccountsTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: feeReceiverKeypair.publicKey,
      space: getAccountLen([]), lamports: tokenLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(feeReceiverKeypair.publicKey, USDC_MINT, marketAuthority, TOKEN_PROGRAM_ID),
  );

  // Collateral supply token account
  createAccountsTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: collateralSupplyKeypair.publicKey,
      space: getAccountLen([]), lamports: tokenLamports, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(collateralSupplyKeypair.publicKey, collateralMintKeypair.publicKey, marketAuthority, TOKEN_PROGRAM_ID),
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, createAccountsTx, [
      payer, reserveKeypair, collateralMintKeypair, liquiditySupplyKeypair,
      feeReceiverKeypair, collateralSupplyKeypair,
    ]);
    console.log("✓ Reserve accounts created:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.error("✗ Account creation failed:", err.message?.slice(0, 300));
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log("  ", l));
    return;
  }

  // ═══ Step 3: Prepare collateral ATA ═══
  console.log("\n── Step 3: Prepare Collateral ATA ──");
  const userUsdcAta = payerUsdcAta; // already created in step 0
  const userCollAta = getAssociatedTokenAddressSync(collateralMintKeypair.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID);

  const prepTx = new Transaction();
  if (!(await connection.getAccountInfo(userCollAta))) {
    prepTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, userCollAta, payer.publicKey, collateralMintKeypair.publicKey, TOKEN_PROGRAM_ID));
  }
  if (prepTx.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, prepTx, [payer]);
  }

  const bal = await connection.getTokenAccountBalance(userUsdcAta);
  console.log("  User USDC balance:", bal.value.uiAmount);

  // ═══ Step 4: InitReserve ═══
  console.log("\n── Step 4: InitReserve ──");

  // ReserveConfig data — conservative defaults for devnet testing
  // Layout: tag(1) + liquidity_amount(8) + config fields
  // Solend devnet extended ReserveConfig layout:
  // tag(1) + liquidity_amount(8) + config fields
  // Field order (from Solend fork source, NOT vanilla SPL):
  //   optimal_utilization_rate(u8), loan_to_value_ratio(u8), liquidation_bonus(u8),
  //   liquidation_threshold(u8), min_borrow_rate(u8), optimal_borrow_rate(u8),
  //   max_borrow_rate(u8), super_max_borrow_rate(u64),
  //   borrow_fee_wad(u64), flash_loan_fee_wad(u64), host_fee_percentage(u8),
  //   deposit_limit(u64), borrow_limit(u64), fee_receiver(Pubkey),
  //   protocol_liquidation_fee(u8), protocol_take_rate(u8),
  //   added_borrow_weight_bps(u64), reserve_type(u8),
  //   max_liquidation_bonus(u8), max_liquidation_threshold(u8),
  //   scaled_price_offset_bps(i64),
  //   extra_oracle_pubkey option(u8) [+ Pubkey if Some],
  //   attributed_borrow_limit_open(u64), attributed_borrow_limit_close(u64)

  const initReserveData = Buffer.alloc(160);
  let offset = 0;

  initReserveData.writeUInt8(2, offset); offset += 1;                    // tag = InitReserve
  new BN(1_000).toArrayLike(Buffer, "le", 8).copy(initReserveData, offset); offset += 8; // liquidity_amount

  // ReserveConfig — Solend fork. Set all u8 fields to safe values.
  // Trying: all rate/threshold fields set so threshold > ltv always holds
  initReserveData.writeUInt8(80, offset); offset += 1;                   // optimal_utilization_rate
  initReserveData.writeUInt8(90, offset); offset += 1;                   // max_utilization_rate
  initReserveData.writeUInt8(50, offset); offset += 1;                   // loan_to_value_ratio
  initReserveData.writeUInt8(5, offset); offset += 1;                    // liquidation_bonus
  initReserveData.writeUInt8(55, offset); offset += 1;                   // liquidation_threshold
  initReserveData.writeUInt8(0, offset); offset += 1;                    // min_borrow_rate
  initReserveData.writeUInt8(4, offset); offset += 1;                    // optimal_borrow_rate
  initReserveData.writeUInt8(50, offset); offset += 1;                   // max_borrow_rate
  initReserveData.writeBigUInt64LE(BigInt(100), offset); offset += 8;    // super_max_borrow_rate
  initReserveData.writeBigUInt64LE(BigInt("10000000000000"), offset); offset += 8; // borrow_fee_wad
  initReserveData.writeBigUInt64LE(BigInt("30000000000000"), offset); offset += 8; // flash_loan_fee_wad
  initReserveData.writeUInt8(20, offset); offset += 1;                   // host_fee_percentage
  initReserveData.writeBigUInt64LE(BigInt("18446744073709551615"), offset); offset += 8; // deposit_limit
  initReserveData.writeBigUInt64LE(BigInt("18446744073709551615"), offset); offset += 8; // borrow_limit
  feeReceiverKeypair.publicKey.toBuffer().copy(initReserveData, offset); offset += 32; // fee_receiver
  initReserveData.writeUInt8(0, offset); offset += 1;                    // protocol_liquidation_fee
  initReserveData.writeUInt8(0, offset); offset += 1;                    // protocol_take_rate
  initReserveData.writeBigUInt64LE(BigInt(0), offset); offset += 8;      // added_borrow_weight_bps
  initReserveData.writeUInt8(0, offset); offset += 1;                    // reserve_type = Regular
  initReserveData.writeUInt8(5, offset); offset += 1;                    // max_liquidation_bonus (= liquidation_bonus)
  initReserveData.writeUInt8(55, offset); offset += 1;                   // max_liquidation_threshold (= liquidation_threshold)
  initReserveData.writeBigInt64LE(BigInt(0), offset); offset += 8;       // scaled_price_offset_bps
  initReserveData.writeUInt8(0, offset); offset += 1;                    // extra_oracle_pubkey = None
  initReserveData.writeBigUInt64LE(BigInt(0), offset); offset += 8;      // attributed_borrow_limit_open
  initReserveData.writeBigUInt64LE(BigInt(0), offset); offset += 8;      // attributed_borrow_limit_close

  console.log("  InitReserve data size:", offset, "bytes (expected 89)");

  const initReserveTx = new Transaction().add({
    programId: SOLEND_PROGRAM,
    keys: [
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },              // 0: source liquidity
      { pubkey: userCollAta, isSigner: false, isWritable: true },              // 1: dest collateral
      { pubkey: reserveKeypair.publicKey, isSigner: false, isWritable: true }, // 2: reserve
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },               // 3: liquidity mint
      { pubkey: liquiditySupplyKeypair.publicKey, isSigner: false, isWritable: true }, // 4: liquidity supply
      { pubkey: feeReceiverKeypair.publicKey, isSigner: false, isWritable: true },     // 5: fee receiver
      { pubkey: collateralMintKeypair.publicKey, isSigner: false, isWritable: true },  // 6: collateral mint
      { pubkey: collateralSupplyKeypair.publicKey, isSigner: false, isWritable: true }, // 7: collateral supply
      { pubkey: pythInfo ? PYTH_USDC_PRODUCT : NULL_PUBKEY, isSigner: false, isWritable: false }, // 8: pyth product
      { pubkey: pythInfo ? PYTH_USDC_PRICE : NULL_PUBKEY, isSigner: false, isWritable: false },   // 9: pyth price
      { pubkey: NULL_PUBKEY, isSigner: false, isWritable: false },             // 10: switchboard (null)
      { pubkey: marketPubkey, isSigner: false, isWritable: false },            // 11: lending market
      { pubkey: marketAuthority, isSigner: false, isWritable: false },         // 12: market authority
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },          // 13: market owner
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },          // 14: user transfer authority
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },      // 15: rent
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // 16: token program
    ],
    data: initReserveData.subarray(0, offset),
  });

  try {
    const sig = await sendAndConfirmTransaction(connection, initReserveTx, [payer]);
    console.log("✓ Reserve initialized:", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.error("✗ InitReserve failed:", err.message?.slice(0, 400));
    if (err.logs) {
      console.log("\n  Program logs:");
      for (const log of err.logs.slice(-10)) console.log("    ", log);
    }
    return;
  }

  // ═══ Output ═══
  console.log("\n═══════════════════════════════════════════════════");
  console.log("SOLEND SETUP COMPLETE");
  console.log("═══════════════════════════════════════════════════");
  console.log("Lending Market:       ", marketPubkey.toBase58());
  console.log("Market Authority:     ", marketAuthority.toBase58());
  console.log("Reserve:              ", reserveKeypair.publicKey.toBase58());
  console.log("Liquidity Mint (USDC):", USDC_MINT.toBase58());
  console.log("Liquidity Supply:     ", liquiditySupplyKeypair.publicKey.toBase58());
  console.log("Collateral Mint:      ", collateralMintKeypair.publicKey.toBase58());
  console.log("Collateral Supply:    ", collateralSupplyKeypair.publicKey.toBase58());
  console.log("Fee Receiver:         ", feeReceiverKeypair.publicKey.toBase58());
  console.log("═══════════════════════════════════════════════════");
  console.log("\nAdd these to lp-constants.ts for frontend integration.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
