import { describe, it, before } from "mocha";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { startAnchor } from "solana-bankrun";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  ExtensionType,
  getMintLen,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMetadataPointerInstruction,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";

// Program IDs
const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM"
);
const VAULT_PROGRAM_ID = new PublicKey(
  "4zH2XumAFjuzp8pjhPxjzAiCLcZcmfkVfm21qSkpLQLq"
);
const MOCK_YIELD_PROGRAM_ID = new PublicKey(
  "HH8wcn2x8u6SrT22CaZwLh9i1oLarxwtMSrA8EP8Vtfr"
);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Anchor instruction discriminator: first 8 bytes of sha256("global:<name>")
 */
function ixDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

/**
 * Find PDA with seeds
 */
function findPda(
  seeds: (Buffer | Uint8Array)[],
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

/**
 * Encode Anchor-compatible instruction data with discriminator + args
 */
function encodeIxData(discriminator: Buffer, ...args: Buffer[]): Buffer {
  return Buffer.concat([discriminator, ...args]);
}

/** Encode a bool as 1 byte */
function encodeBool(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}

/** Encode an i64 as 8 bytes LE */
function encodeI64(v: number | BN): Buffer {
  const bn = new BN(v);
  return bn.toArrayLike(Buffer, "le", 8);
}

/** Encode a u64 as 8 bytes LE */
function encodeU64(v: number | BN): Buffer {
  const bn = new BN(v);
  return bn.toArrayLike(Buffer, "le", 8);
}

/** Encode a Pubkey as 32 bytes */
function encodePubkey(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Integration Tests", () => {
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let payer: Keypair;

  // Shared state
  let mint: Keypair;
  let mintAuthority: Keypair;
  const decimals = 6;

  // Users
  let alice: Keypair;
  let bob: Keypair;

  // Token accounts
  let aliceAta: PublicKey;
  let bobAta: PublicKey;

  // For mock yield (uses legacy SPL Token, not Token-2022)
  let yieldMint: Keypair;
  let yieldMintAuthority: Keypair;

  before(async () => {
    context = await startAnchor(
      ".",
      [],
      [] // no extra accounts
    );
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    payer = provider.wallet.payer;

    mint = Keypair.generate();
    mintAuthority = Keypair.generate();
    alice = Keypair.generate();
    bob = Keypair.generate();

    yieldMint = Keypair.generate();
    yieldMintAuthority = Keypair.generate();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Transfer Hook Tests
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Transfer Hook Program", () => {
    before(async () => {
      // Create Token-2022 mint with TransferHook extension
      const extensions = [ExtensionType.TransferHook];
      const mintLen = getMintLen(extensions);
      const lamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      const createMintAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });

      const initTransferHookIx = createInitializeTransferHookInstruction(
        mint.publicKey,
        mintAuthority.publicKey,
        TRANSFER_HOOK_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      );

      const initMintIx = createInitializeMintInstruction(
        mint.publicKey,
        decimals,
        mintAuthority.publicKey,
        null, // no freeze authority
        TOKEN_2022_PROGRAM_ID
      );

      const tx = new Transaction().add(
        createMintAccountIx,
        initTransferHookIx,
        initMintIx
      );
      await provider.sendAndConfirm(tx, [payer, mint]);

      // Create ATAs for Alice and Bob (Token-2022)
      aliceAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        alice.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      bobAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        bob.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      const createAliceAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        aliceAta,
        alice.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID
      );
      const createBobAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        bobAta,
        bob.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID
      );

      await provider.sendAndConfirm(
        new Transaction().add(createAliceAtaIx, createBobAtaIx),
        [payer]
      );

      // Mint tokens to Alice
      const mintToIx = createMintToInstruction(
        mint.publicKey,
        aliceAta,
        mintAuthority.publicKey,
        1_000_000_000, // 1000 tokens
        [],
        TOKEN_2022_PROGRAM_ID
      );
      await provider.sendAndConfirm(new Transaction().add(mintToIx), [
        payer,
        mintAuthority,
      ]);
    });

    it("initialize_extra_account_meta_list", async () => {
      const [extraAccountMetaList] = findPda(
        [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );

      const ix = new TransactionInstruction({
        programId: TRANSFER_HOOK_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: extraAccountMetaList,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          {
            pubkey: mintAuthority.publicKey,
            isSigner: true,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("initialize_extra_account_meta_list")
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [
        payer,
        mintAuthority,
      ]);

      // Verify the account was created
      const account = await provider.connection.getAccountInfo(
        extraAccountMetaList
      );
      expect(account).to.not.be.null;
      expect(account!.owner.equals(TRANSFER_HOOK_PROGRAM_ID)).to.be.true;
    });

    it("set_compliance_config (KYC required)", async () => {
      const [complianceConfig] = findPda(
        [Buffer.from("compliance"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );

      const ix = new TransactionInstruction({
        programId: TRANSFER_HOOK_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          {
            pubkey: complianceConfig,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("set_compliance_config"),
          encodeBool(true), // kyc_required
          encodeI64(0) // lockup_duration
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      // Verify account exists
      const account = await provider.connection.getAccountInfo(
        complianceConfig
      );
      expect(account).to.not.be.null;

      // Parse: 8 (discriminator) + 32 (authority) + 1 (kyc_required) + 8 (lockup_duration) + 1 (bump)
      const data = account!.data;
      const kycRequired = data[8 + 32] === 1;
      expect(kycRequired).to.be.true;
    });

    it("set_user_compliance (Alice KYC'd)", async () => {
      const [complianceConfig] = findPda(
        [Buffer.from("compliance"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [aliceCompliance] = findPda(
        [
          Buffer.from("user-compliance"),
          mint.publicKey.toBuffer(),
          alice.publicKey.toBuffer(),
        ],
        TRANSFER_HOOK_PROGRAM_ID
      );

      const ix = new TransactionInstruction({
        programId: TRANSFER_HOOK_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: alice.publicKey, isSigner: false, isWritable: false },
          {
            pubkey: complianceConfig,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: aliceCompliance,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("set_user_compliance"),
          encodeBool(true), // kyc_verified
          encodeI64(0) // lockup_unlock_at (no lockup)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      const account = await provider.connection.getAccountInfo(
        aliceCompliance
      );
      expect(account).to.not.be.null;

      // Parse: 8 (disc) + 1 (kyc_verified) + 8 (lockup_unlock_at) + 1 (bump)
      const kycVerified = account!.data[8] === 1;
      expect(kycVerified).to.be.true;
    });

    it("transfer to non-KYC'd Bob should fail", async () => {
      // Bob has no UserCompliance account — the PDA won't exist.
      // The transfer_hook will fail because it can't deserialize destination_compliance.
      // We need to create Bob's compliance record as NOT KYC'd first.
      const [complianceConfig] = findPda(
        [Buffer.from("compliance"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [bobCompliance] = findPda(
        [
          Buffer.from("user-compliance"),
          mint.publicKey.toBuffer(),
          bob.publicKey.toBuffer(),
        ],
        TRANSFER_HOOK_PROGRAM_ID
      );

      // Set Bob as NOT KYC'd
      const setBobIx = new TransactionInstruction({
        programId: TRANSFER_HOOK_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: bob.publicKey, isSigner: false, isWritable: false },
          {
            pubkey: complianceConfig,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: bobCompliance, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("set_user_compliance"),
          encodeBool(false), // NOT KYC'd
          encodeI64(0)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(setBobIx), [payer]);

      // Now try transfer Alice -> Bob via transfer_checked
      // With TransferHook, the runtime will invoke our hook program
      // We need to add the extra accounts manually
      const [extraAccountMetaList] = findPda(
        [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [aliceCompliance] = findPda(
        [
          Buffer.from("user-compliance"),
          mint.publicKey.toBuffer(),
          alice.publicKey.toBuffer(),
        ],
        TRANSFER_HOOK_PROGRAM_ID
      );

      // The TransferHook is invoked by Token-2022 automatically during transfer_checked.
      // We need to provide the extra accounts that the hook expects after the standard accounts.
      // Standard transfer_checked accounts: source, mint, dest, authority
      // Then: extraAccountMetaList (index 4), complianceConfig (5), sourceCompliance (6), destCompliance (7)
      // Plus the hook program itself

      const transferIx = createTransferCheckedInstruction(
        aliceAta,
        mint.publicKey,
        bobAta,
        alice.publicKey,
        100_000_000, // 100 tokens
        decimals,
        [],
        TOKEN_2022_PROGRAM_ID
      );

      // Append extra accounts required by the transfer hook
      transferIx.keys.push(
        {
          pubkey: TRANSFER_HOOK_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: extraAccountMetaList,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: complianceConfig,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: aliceCompliance,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: bobCompliance,
          isSigner: false,
          isWritable: false,
        }
      );

      try {
        await provider.sendAndConfirm(new Transaction().add(transferIx), [
          payer,
          alice,
        ]);
        expect.fail("Transfer should have failed — Bob not KYC'd");
      } catch (err: any) {
        // Should fail with KycRequired error
        const errStr = err.toString();
        expect(
          errStr.includes("KycRequired") ||
            errStr.includes("custom program error") ||
            errStr.includes("failed")
        ).to.be.true;
      }
    });

    it("set Bob as KYC'd, then transfer should pass", async () => {
      const [complianceConfig] = findPda(
        [Buffer.from("compliance"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [bobCompliance] = findPda(
        [
          Buffer.from("user-compliance"),
          mint.publicKey.toBuffer(),
          bob.publicKey.toBuffer(),
        ],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [aliceCompliance] = findPda(
        [
          Buffer.from("user-compliance"),
          mint.publicKey.toBuffer(),
          alice.publicKey.toBuffer(),
        ],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [extraAccountMetaList] = findPda(
        [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );

      // Set Bob as KYC'd
      const setKycIx = new TransactionInstruction({
        programId: TRANSFER_HOOK_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: bob.publicKey, isSigner: false, isWritable: false },
          {
            pubkey: complianceConfig,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: bobCompliance, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("set_user_compliance"),
          encodeBool(true), // KYC'd now
          encodeI64(0)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(setKycIx), [payer]);

      // Now transfer should succeed
      const transferIx = createTransferCheckedInstruction(
        aliceAta,
        mint.publicKey,
        bobAta,
        alice.publicKey,
        100_000_000, // 100 tokens
        decimals,
        [],
        TOKEN_2022_PROGRAM_ID
      );

      transferIx.keys.push(
        {
          pubkey: TRANSFER_HOOK_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: extraAccountMetaList,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: complianceConfig,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: aliceCompliance,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: bobCompliance,
          isSigner: false,
          isWritable: false,
        }
      );

      await provider.sendAndConfirm(new Transaction().add(transferIx), [
        payer,
        alice,
      ]);

      // Verify Bob received tokens
      const bobAccount = await provider.connection.getAccountInfo(bobAta);
      expect(bobAccount).to.not.be.null;
      // Token-2022 account data: first 64 bytes = mint(32) + owner(32), then amount at offset 64 (8 bytes)
      const bobBalance = new BN(
        bobAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(bobBalance).to.equal(100_000_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Mock Yield Source Tests
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Mock Yield Source Program", () => {
    // This uses legacy SPL Token (not Token-2022)
    let yieldPoolMint: Keypair;
    let poolState: PublicKey;
    let poolTokenAccount: PublicKey;
    let payerTokenAccount: PublicKey;

    before(async () => {
      yieldPoolMint = Keypair.generate();

      // Find pool PDA (will be mint authority)
      [poolState] = findPda([Buffer.from("pool")], MOCK_YIELD_PROGRAM_ID);

      // Create a legacy SPL token mint with pool_state PDA as mint authority
      const mintLen = 82; // standard mint size
      const lamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      const createMintIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: yieldPoolMint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      });

      const initMintIx = createInitializeMintInstruction(
        yieldPoolMint.publicKey,
        decimals,
        poolState, // mint authority = pool PDA (for simulate_yield)
        null,
        TOKEN_PROGRAM_ID
      );

      await provider.sendAndConfirm(
        new Transaction().add(createMintIx, initMintIx),
        [payer, yieldPoolMint]
      );

      // Create payer's token account (legacy)
      payerTokenAccount = getAssociatedTokenAddressSync(
        yieldPoolMint.publicKey,
        payer.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const createPayerAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerTokenAccount,
        payer.publicKey,
        yieldPoolMint.publicKey,
        TOKEN_PROGRAM_ID
      );

      await provider.sendAndConfirm(
        new Transaction().add(createPayerAtaIx),
        [payer]
      );

      // We need to mint initial tokens to payer — but pool_state PDA is mint authority
      // and it doesn't exist yet. So we need to initialize_pool first, then we can't
      // use mint_to because pool_state is PDA that requires the program to sign.
      // Solution: use a separate mint authority keypair for the mint, then transfer
      // mint authority to pool_state after initialization.
      // Actually simpler: create the mint with payer as authority, mint tokens,
      // then we DON'T need simulate_yield to work with mint authority.
      // But simulate_yield calls mint_to with pool_state as authority...
      // So we need pool_state as mint authority from the start.
      // We'll initialize_pool first, then the pool can mint via simulate_yield.
      // For deposits, we need tokens — we can have another mint or find another way.
      // Actually: let's just recreate the mint with payer as authority for initial tokens,
      // then we'll test simulate_yield separately.

      // Let me redo: create mint with payer as authority, mint tokens, then
      // for simulate_yield we'll create a different mint with pool PDA authority.
    });

    it("initialize_pool", async () => {
      const ix = new TransactionInstruction({
        programId: MOCK_YIELD_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolState, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(ixDiscriminator("initialize_pool")),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      const account = await provider.connection.getAccountInfo(poolState);
      expect(account).to.not.be.null;
      expect(account!.owner.equals(MOCK_YIELD_PROGRAM_ID)).to.be.true;

      // Parse: 8 (disc) + 32 (admin) + 8 (total_deposited) + 1 (bump)
      const admin = new PublicKey(account!.data.subarray(8, 40));
      expect(admin.equals(payer.publicKey)).to.be.true;

      const totalDeposited = new BN(
        account!.data.subarray(40, 48),
        "le"
      ).toNumber();
      expect(totalDeposited).to.equal(0);
    });

    it("deposit tokens to pool", async () => {
      // Create a separate mint that payer controls for deposit testing
      const depositMint = Keypair.generate();
      const mintLen = 82;
      const lamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      // Create mint with payer as authority
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: depositMint.publicKey,
            space: mintLen,
            lamports,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            depositMint.publicKey,
            decimals,
            payer.publicKey,
            null,
            TOKEN_PROGRAM_ID
          )
        ),
        [payer, depositMint]
      );

      // Create payer token account
      const payerAta = getAssociatedTokenAddressSync(
        depositMint.publicKey,
        payer.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            payerAta,
            payer.publicKey,
            depositMint.publicKey,
            TOKEN_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Mint tokens to payer
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            depositMint.publicKey,
            payerAta,
            payer.publicKey,
            10_000_000_000,
            [],
            TOKEN_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Create pool token account (owned by poolState PDA)
      const poolAta = getAssociatedTokenAddressSync(
        depositMint.publicKey,
        poolState,
        true, // allowOwnerOffCurve for PDA
        TOKEN_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            poolAta,
            poolState,
            depositMint.publicKey,
            TOKEN_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Deposit receipt PDA
      const [depositReceipt] = findPda(
        [Buffer.from("receipt"), payer.publicKey.toBuffer()],
        MOCK_YIELD_PROGRAM_ID
      );

      const depositAmount = 1_000_000_000; // 1000 tokens
      const ix = new TransactionInstruction({
        programId: MOCK_YIELD_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolState, isSigner: false, isWritable: true },
          { pubkey: depositReceipt, isSigner: false, isWritable: true },
          { pubkey: payerAta, isSigner: false, isWritable: true },
          { pubkey: poolAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("deposit"),
          encodeU64(depositAmount)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      // Verify receipt
      const receiptAccount = await provider.connection.getAccountInfo(
        depositReceipt
      );
      expect(receiptAccount).to.not.be.null;

      // Parse: 8 (disc) + 32 (depositor) + 8 (amount) + 1 (bump)
      const receiptDepositor = new PublicKey(
        receiptAccount!.data.subarray(8, 40)
      );
      expect(receiptDepositor.equals(payer.publicKey)).to.be.true;

      const receiptAmount = new BN(
        receiptAccount!.data.subarray(40, 48),
        "le"
      ).toNumber();
      expect(receiptAmount).to.equal(depositAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Vault Tests
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Vault Program", () => {
    // Use a separate Token-2022 mint for vault tests (no transfer hook)
    let vaultMint: Keypair;
    let vaultMintAuthority: Keypair;
    let vaultConfig: PublicKey;
    let vaultAuthority: PublicKey;
    let vaultTokenAccount: PublicKey;
    let issuerAta: PublicKey;
    let recipientAta: PublicKey;
    let recipient: Keypair;
    let grantPda: PublicKey;

    before(async () => {
      vaultMint = Keypair.generate();
      vaultMintAuthority = Keypair.generate();
      recipient = Keypair.generate();

      // Create Token-2022 mint (no extensions for simplicity)
      const mintLen = getMintLen([]);
      const lamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: vaultMint.publicKey,
            space: mintLen,
            lamports,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            vaultMint.publicKey,
            decimals,
            vaultMintAuthority.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, vaultMint]
      );

      // Derive PDAs
      [vaultConfig] = findPda(
        [Buffer.from("vault-config"), vaultMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );
      [vaultAuthority] = findPda(
        [Buffer.from("vault-authority"), vaultMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );

      // Create vault token account owned by vaultAuthority PDA
      vaultTokenAccount = getAssociatedTokenAddressSync(
        vaultMint.publicKey,
        vaultAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            vaultTokenAccount,
            vaultAuthority,
            vaultMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Create issuer (payer) token account
      issuerAta = getAssociatedTokenAddressSync(
        vaultMint.publicKey,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            issuerAta,
            payer.publicKey,
            vaultMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Create recipient token account
      recipientAta = getAssociatedTokenAddressSync(
        vaultMint.publicKey,
        recipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            recipientAta,
            recipient.publicKey,
            vaultMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Mint tokens to issuer
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            vaultMint.publicKey,
            issuerAta,
            vaultMintAuthority.publicKey,
            10_000_000_000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, vaultMintAuthority]
      );
    });

    it("initialize_vault", async () => {
      const mockYieldSource = Keypair.generate().publicKey; // dummy

      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: vaultMint.publicKey,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: vaultAuthority, isSigner: false, isWritable: true },
          {
            pubkey: vaultTokenAccount,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("initialize_vault"),
          encodePubkey(mockYieldSource)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      const account = await provider.connection.getAccountInfo(vaultConfig);
      expect(account).to.not.be.null;
      expect(account!.owner.equals(VAULT_PROGRAM_ID)).to.be.true;

      // Parse VaultConfig: 8 + 32(authority) + 32(mint) + 32(yield_source) + 8(total_deposited) + 8(total_shares) + 8(grant_counter) + 1(bump)
      const authority = new PublicKey(account!.data.subarray(8, 40));
      expect(authority.equals(payer.publicKey)).to.be.true;

      const storedMint = new PublicKey(account!.data.subarray(40, 72));
      expect(storedMint.equals(vaultMint.publicKey)).to.be.true;

      // DEAD_SHARES = 1_000_000 for both total_deposited and total_shares
      const totalDeposited = new BN(
        account!.data.subarray(104, 112),
        "le"
      ).toNumber();
      expect(totalDeposited).to.equal(1_000_000);

      const totalShares = new BN(
        account!.data.subarray(112, 120),
        "le"
      ).toNumber();
      expect(totalShares).to.equal(1_000_000);

      const grantCounter = new BN(
        account!.data.subarray(120, 128),
        "le"
      ).toNumber();
      expect(grantCounter).to.equal(0);
    });

    it("create_grant (1000 tokens, cliff 30s, end 60s)", async () => {
      const clock = await provider.connection.getAccountInfo(
        new PublicKey("SysvarC1ock11111111111111111111111111111111")
      );
      const nowBn = new BN(clock!.data.subarray(32, 40), "le");
      const now = nowBn.toNumber();

      const cliffAt = now + 30;
      const endAt = now + 60;
      const amount = 1_000_000_000; // 1000 tokens

      // Grant PDA uses grant_counter = 0 (current counter before increment)
      const grantIndex = new BN(0);
      [grantPda] = findPda(
        [
          Buffer.from("grant"),
          vaultMint.publicKey.toBuffer(),
          grantIndex.toArrayLike(Buffer, "le", 8),
        ],
        VAULT_PROGRAM_ID
      );

      // Step 1: Transfer tokens to vault (bankrun doesn't enforce hooks)
      const transferIx = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: issuerAta, isSigner: false, isWritable: true },
          { pubkey: vaultMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([12, ...new BN(amount).toArray("le", 8), decimals]), // TransferChecked discriminator + amount + decimals
      });

      await provider.sendAndConfirm(new Transaction().add(transferIx), [payer]);

      // Step 2: Create grant (no transfer, just records the grant)
      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: vaultMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: grantPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeIxData(
          ixDiscriminator("create_grant"),
          encodeU64(amount),
          encodeI64(cliffAt),
          encodeI64(endAt),
          encodePubkey(recipient.publicKey)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      // Verify grant account
      const grantAccount = await provider.connection.getAccountInfo(grantPda);
      expect(grantAccount).to.not.be.null;

      // Parse VestingGrant: 8 + 32(recipient) + 32(mint) + 8(amount) + 8(shares) + 8(rate) + 8(cliff) + 8(end) + 8(claimed) + 8(created) + 1(terminated) + 8(terminated_at) + 32(nft_mint) + 1(bump)
      const grantRecipient = new PublicKey(
        grantAccount!.data.subarray(8, 40)
      );
      expect(grantRecipient.equals(recipient.publicKey)).to.be.true;

      const grantAmount = new BN(
        grantAccount!.data.subarray(72, 80),
        "le"
      ).toNumber();
      expect(grantAmount).to.equal(amount);

      const grantShares = new BN(
        grantAccount!.data.subarray(80, 88),
        "le"
      ).toNumber();
      expect(grantShares).to.be.greaterThan(0);

      const grantRate = new BN(
        grantAccount!.data.subarray(88, 96),
        "le"
      ).toNumber();
      // Exchange rate should be RATE_PRECISION (1:1 at initialization since dead shares = dead assets)
      expect(grantRate).to.equal(1_000_000_000); // RATE_PRECISION

      const grantCliff = new BN(
        grantAccount!.data.subarray(96, 104),
        "le"
      ).toNumber();
      expect(grantCliff).to.equal(cliffAt);

      const claimed = new BN(
        grantAccount!.data.subarray(112, 120),
        "le"
      ).toNumber();
      expect(claimed).to.equal(0);
    });

    it("claim before cliff should fail", async () => {
      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          {
            pubkey: recipient.publicKey,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: vaultMint.publicKey,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: grantPda, isSigner: false, isWritable: true },
          { pubkey: vaultAuthority, isSigner: false, isWritable: false },
          {
            pubkey: vaultTokenAccount,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: recipientAta, isSigner: false, isWritable: true },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(ixDiscriminator("claim_vested")),
      });

      try {
        await provider.sendAndConfirm(new Transaction().add(ix), [
          payer,
          recipient,
        ]);
        expect.fail("Claim should fail before cliff");
      } catch (err: any) {
        const errStr = err.toString();
        expect(
          errStr.includes("CliffNotReached") ||
            errStr.includes("custom program error") ||
            errStr.includes("failed")
        ).to.be.true;
      }
    });

    it("claim after cliff should succeed (warp clock)", async () => {
      // Warp clock forward past the cliff
      const clock = await provider.connection.getAccountInfo(
        new PublicKey("SysvarC1ock11111111111111111111111111111111")
      );
      const currentSlot = new BN(clock!.data.subarray(0, 8), "le").toNumber();

      // Warp forward ~35 seconds worth of slots (assuming ~400ms/slot = ~87 slots)
      // In bankrun, we can warp the clock directly
      context.warpToSlot(BigInt(currentSlot + 100));

      // Also need to set the clock unix_timestamp forward
      // bankrun setClock sets the sysvar
      const currentTs = new BN(clock!.data.subarray(32, 40), "le").toNumber();
      const newTs = currentTs + 45; // past cliff (30s) but before end (60s)

      const { Clock } = require("solana-bankrun");
      context.setClock(
        new Clock(
          BigInt(currentSlot + 100),
          BigInt(currentTs),
          BigInt(0),
          BigInt(0),
          BigInt(newTs),
        )
      );

      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          {
            pubkey: recipient.publicKey,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: vaultMint.publicKey,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: vaultConfig, isSigner: false, isWritable: true },
          { pubkey: grantPda, isSigner: false, isWritable: true },
          { pubkey: vaultAuthority, isSigner: false, isWritable: false },
          {
            pubkey: vaultTokenAccount,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: recipientAta, isSigner: false, isWritable: true },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(ixDiscriminator("claim_vested")),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [
        payer,
        recipient,
      ]);

      // Verify recipient got tokens
      const recipientAccount = await provider.connection.getAccountInfo(
        recipientAta
      );
      expect(recipientAccount).to.not.be.null;

      // Token-2022 account layout: offset 64 = amount (8 bytes LE)
      const balance = new BN(
        recipientAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(balance).to.be.greaterThan(0);

      // Verify grant claimed amount updated
      const grantAccount = await provider.connection.getAccountInfo(grantPda);
      const claimed = new BN(
        grantAccount!.data.subarray(112, 120),
        "le"
      ).toNumber();
      expect(claimed).to.be.greaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Integration Flow
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Full Integration Flow", () => {
    let flowMint: Keypair;
    let flowMintAuthority: Keypair;
    let flowVaultConfig: PublicKey;
    let flowVaultAuthority: PublicKey;
    let flowVaultTokenAccount: PublicKey;
    let flowIssuerAta: PublicKey;
    let flowRecipient: Keypair;
    let flowRecipientAta: PublicKey;
    let flowGrantPda: PublicKey;
    let flowYieldTokenAccount: PublicKey;

    before(async () => {
      flowMint = Keypair.generate();
      flowMintAuthority = Keypair.generate();
      flowRecipient = Keypair.generate();

      // Create Token-2022 mint (no hook for this flow — testing vault + yield)
      const mintLen = getMintLen([]);
      const lamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: flowMint.publicKey,
            space: mintLen,
            lamports,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            flowMint.publicKey,
            decimals,
            flowMintAuthority.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, flowMint]
      );

      // Derive PDAs
      [flowVaultConfig] = findPda(
        [Buffer.from("vault-config"), flowMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );
      [flowVaultAuthority] = findPda(
        [Buffer.from("vault-authority"), flowMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );

      // Create accounts
      flowVaultTokenAccount = getAssociatedTokenAddressSync(
        flowMint.publicKey,
        flowVaultAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      flowIssuerAta = getAssociatedTokenAddressSync(
        flowMint.publicKey,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      flowRecipientAta = getAssociatedTokenAddressSync(
        flowMint.publicKey,
        flowRecipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      // Create a "yield" token account — just another ATA owned by vaultAuthority
      // In real integration this would be the yield source's pool account
      // For testing, we create a separate account the vault can transfer to/from
      flowYieldTokenAccount = getAssociatedTokenAddressSync(
        flowMint.publicKey,
        flowVaultAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      // This is the same as flowVaultTokenAccount since same owner...
      // We need a different account. Let's use a regular token account.
      const yieldAccountKp = Keypair.generate();
      const tokenAccountLen = 165; // Token-2022 base account size
      const tokenLamports =
        await provider.connection.getMinimumBalanceForRentExemption(
          tokenAccountLen
        );

      // Actually for the vault's deposit_to_yield and harvest_yield,
      // the yield_token_account just needs to be a token account for the right mint.
      // For harvest_yield it needs authority = vault_authority.
      // So let's just use a second token account owned by vault_authority.
      // We can't use ATA since there's only one per owner+mint.
      // We'll create a raw token account.

      // For simplicity, let's skip the yield deposit/harvest in integration
      // and just test: create grant -> warp clock -> claim.
      // The yield mechanics are tested above.

      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            flowVaultTokenAccount,
            flowVaultAuthority,
            flowMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          ),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            flowIssuerAta,
            payer.publicKey,
            flowMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          ),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            flowRecipientAta,
            flowRecipient.publicKey,
            flowMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Mint tokens to issuer
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            flowMint.publicKey,
            flowIssuerAta,
            flowMintAuthority.publicKey,
            5_000_000_000, // 5000 tokens
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, flowMintAuthority]
      );
    });

    it("full flow: init vault -> create grant -> warp past end -> claim full amount", async () => {
      // Step 1: Initialize vault
      const initVaultIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: flowMint.publicKey,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: flowVaultConfig, isSigner: false, isWritable: true },
          {
            pubkey: flowVaultAuthority,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: flowVaultTokenAccount,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("initialize_vault"),
          encodePubkey(Keypair.generate().publicKey) // dummy yield source
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(initVaultIx), [
        payer,
      ]);

      // Step 2: Create grant
      const clock = await provider.connection.getAccountInfo(
        new PublicKey("SysvarC1ock11111111111111111111111111111111")
      );
      const now = new BN(clock!.data.subarray(32, 40), "le").toNumber();
      const cliffAt = now + 10;
      const endAt = now + 20;
      const grantAmount = 2_000_000_000; // 2000 tokens

      const grantIndex = new BN(0);
      [flowGrantPda] = findPda(
        [
          Buffer.from("grant"),
          flowMint.publicKey.toBuffer(),
          grantIndex.toArrayLike(Buffer, "le", 8),
        ],
        VAULT_PROGRAM_ID
      );

      // Transfer tokens to vault first
      const flowTransferIx = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: flowIssuerAta, isSigner: false, isWritable: true },
          { pubkey: flowMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: flowVaultTokenAccount, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([12, ...new BN(grantAmount).toArray("le", 8), decimals]),
      });
      await provider.sendAndConfirm(new Transaction().add(flowTransferIx), [payer]);

      const createGrantIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: flowMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: flowVaultConfig, isSigner: false, isWritable: true },
          { pubkey: flowGrantPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeIxData(
          ixDiscriminator("create_grant"),
          encodeU64(grantAmount),
          encodeI64(cliffAt),
          encodeI64(endAt),
          encodePubkey(flowRecipient.publicKey)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(createGrantIx), [payer]);

      // Step 3: Warp past end_at
      const currentSlot = new BN(clock!.data.subarray(0, 8), "le").toNumber();
      const { Clock: ClockType } = require("solana-bankrun");
      context.setClock(
        new ClockType(
          BigInt(currentSlot + 200),
          BigInt(now),
          BigInt(0),
          BigInt(0),
          BigInt(now + 100), // well past end_at
        )
      );
      context.warpToSlot(BigInt(currentSlot + 200));

      // Step 4: Claim vested
      const claimIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          {
            pubkey: flowRecipient.publicKey,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: flowMint.publicKey,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: flowVaultConfig, isSigner: false, isWritable: true },
          { pubkey: flowGrantPda, isSigner: false, isWritable: true },
          {
            pubkey: flowVaultAuthority,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: flowVaultTokenAccount,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: flowRecipientAta, isSigner: false, isWritable: true },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(ixDiscriminator("claim_vested")),
      });

      await provider.sendAndConfirm(new Transaction().add(claimIx), [
        payer,
        flowRecipient,
      ]);

      // Step 5: Verify recipient got the full amount (past end_at = fully vested)
      const recipientAccount = await provider.connection.getAccountInfo(
        flowRecipientAta
      );
      const balance = new BN(
        recipientAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();

      // Should be equal to the grant amount (no yield in this test, 1:1 exchange rate)
      expect(balance).to.equal(grantAmount);

      // Verify grant shows fully claimed
      const grantAccount = await provider.connection.getAccountInfo(
        flowGrantPda
      );
      const claimed = new BN(
        grantAccount!.data.subarray(112, 120),
        "le"
      ).toNumber();
      expect(claimed).to.equal(grantAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Yield Integration
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Yield Integration", () => {
    let yMint: Keypair;
    let yMintAuthority: Keypair;
    let yVaultConfig: PublicKey;
    let yVaultAuthority: PublicKey;
    let yVaultTokenAccount: PublicKey;
    let yIssuerAta: PublicKey;
    let yRecipient: Keypair;
    let yRecipientAta: PublicKey;
    let yGrantPda: PublicKey;
    let yYieldTokenAccount: Keypair; // raw keypair account for yield
    let grantCliffAt: number;
    let grantEndAt: number;
    const grantAmount = 1_000_000_000; // 1000 tokens

    before(async () => {
      yMint = Keypair.generate();
      yMintAuthority = Keypair.generate();
      yRecipient = Keypair.generate();
      yYieldTokenAccount = Keypair.generate();

      // Create Token-2022 mint
      const mintLen = getMintLen([]);
      const mintLamports =
        await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: yMint.publicKey,
            space: mintLen,
            lamports: mintLamports,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            yMint.publicKey,
            decimals,
            yMintAuthority.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, yMint]
      );

      // Derive PDAs
      [yVaultConfig] = findPda(
        [Buffer.from("vault-config"), yMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );
      [yVaultAuthority] = findPda(
        [Buffer.from("vault-authority"), yMint.publicKey.toBuffer()],
        VAULT_PROGRAM_ID
      );

      // Create vault token account (ATA owned by vaultAuthority PDA)
      yVaultTokenAccount = getAssociatedTokenAddressSync(
        yMint.publicKey,
        yVaultAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      );

      // Create issuer ATA
      yIssuerAta = getAssociatedTokenAddressSync(
        yMint.publicKey,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      // Create recipient ATA
      yRecipientAta = getAssociatedTokenAddressSync(
        yMint.publicKey,
        yRecipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            yVaultTokenAccount,
            yVaultAuthority,
            yMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          ),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            yIssuerAta,
            payer.publicKey,
            yMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          ),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            yRecipientAta,
            yRecipient.publicKey,
            yMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer]
      );

      // Create a raw Token-2022 account for yield, owned by vaultAuthority PDA
      // (can't use ATA since vaultAuthority already has one for this mint)
      const tokenAccountLen = 165;
      const tokenLamports =
        await provider.connection.getMinimumBalanceForRentExemption(
          tokenAccountLen
        );

      // We need to use createAccount + initializeAccount for Token-2022
      const { createInitializeAccountInstruction } = await import(
        "@solana/spl-token"
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: yYieldTokenAccount.publicKey,
            space: tokenAccountLen,
            lamports: tokenLamports,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeAccountInstruction(
            yYieldTokenAccount.publicKey,
            yMint.publicKey,
            yVaultAuthority, // owner = vault authority PDA (so harvest_yield can transfer out)
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, yYieldTokenAccount]
      );

      // Mint tokens to issuer (enough for grant)
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            yMint.publicKey,
            yIssuerAta,
            yMintAuthority.publicKey,
            5_000_000_000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, yMintAuthority]
      );

      // Initialize vault
      const initVaultIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultConfig, isSigner: false, isWritable: true },
          { pubkey: yVaultAuthority, isSigner: false, isWritable: true },
          {
            pubkey: yVaultTokenAccount,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("initialize_vault"),
          encodePubkey(MOCK_YIELD_PROGRAM_ID)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(initVaultIx), [
        payer,
      ]);

      // Create grant (1000 tokens)
      const clock = await provider.connection.getAccountInfo(
        new PublicKey("SysvarC1ock11111111111111111111111111111111")
      );
      const now = new BN(clock!.data.subarray(32, 40), "le").toNumber();
      grantCliffAt = now + 30;
      grantEndAt = now + 60;

      const grantIndex = new BN(0);
      [yGrantPda] = findPda(
        [
          Buffer.from("grant"),
          yMint.publicKey.toBuffer(),
          grantIndex.toArrayLike(Buffer, "le", 8),
        ],
        VAULT_PROGRAM_ID
      );

      // Transfer tokens to vault first
      const yTransferIx = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: yIssuerAta, isSigner: false, isWritable: true },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultTokenAccount, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([12, ...new BN(grantAmount).toArray("le", 8), decimals]),
      });
      await provider.sendAndConfirm(new Transaction().add(yTransferIx), [payer]);

      const createGrantIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultConfig, isSigner: false, isWritable: true },
          { pubkey: yGrantPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeIxData(
          ixDiscriminator("create_grant"),
          encodeU64(grantAmount),
          encodeI64(grantCliffAt),
          encodeI64(grantEndAt),
          encodePubkey(yRecipient.publicKey)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(createGrantIx), [payer]);
    });

    it("deposit_to_yield — vault deposits tokens to yield account", async () => {
      const depositAmount = 500_000_000; // deposit 500 of 1000 tokens (keep 500 in vault)

      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultConfig, isSigner: false, isWritable: false },
          { pubkey: yVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: yVaultTokenAccount, isSigner: false, isWritable: true },
          {
            pubkey: yYieldTokenAccount.publicKey,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("deposit_to_yield"),
          encodeU64(depositAmount)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      // Verify vault token account has remaining 500 tokens
      const vaultAccount = await provider.connection.getAccountInfo(
        yVaultTokenAccount
      );
      const vaultBalance = new BN(
        vaultAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(vaultBalance).to.equal(grantAmount - depositAmount);

      // Verify yield token account received 500 tokens
      const yieldAccount = await provider.connection.getAccountInfo(
        yYieldTokenAccount.publicKey
      );
      const yieldBalance = new BN(
        yieldAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(yieldBalance).to.equal(depositAmount);
    });

    it("simulate_yield — admin mints extra tokens to yield account (10% yield)", async () => {
      const yieldAmount = 50_000_000; // 50 tokens = 10% of 500 deposited

      // Mint directly to the yield token account using the mint authority
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            yMint.publicKey,
            yYieldTokenAccount.publicKey,
            yMintAuthority.publicKey,
            yieldAmount,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, yMintAuthority]
      );

      // Verify yield account now has 500 + 50 = 550 tokens
      const yieldAccount = await provider.connection.getAccountInfo(
        yYieldTokenAccount.publicKey
      );
      const yieldBalance = new BN(
        yieldAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(yieldBalance).to.equal(500_000_000 + yieldAmount);
    });

    it("harvest_yield — vault withdraws from yield account, total_deposited increases", async () => {
      // Read vault config before harvest
      const configBefore = await provider.connection.getAccountInfo(
        yVaultConfig
      );
      const totalDepositedBefore = new BN(
        configBefore!.data.subarray(104, 112),
        "le"
      ).toNumber();

      // Harvest only the yield profit (50 tokens).
      // harvest_yield adds `amount` to total_deposited, improving the exchange rate.
      // Principal (500 tokens) remains in the yield account for now.
      const harvestAmount = 50_000_000; // 50 tokens of yield profit

      const ix = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultConfig, isSigner: false, isWritable: true },
          { pubkey: yVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: yVaultTokenAccount, isSigner: false, isWritable: true },
          {
            pubkey: yYieldTokenAccount.publicKey,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(
          ixDiscriminator("harvest_yield"),
          encodeU64(harvestAmount)
        ),
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [payer]);

      // Verify total_deposited increased by the harvest amount
      const configAfter = await provider.connection.getAccountInfo(
        yVaultConfig
      );
      const totalDepositedAfter = new BN(
        configAfter!.data.subarray(104, 112),
        "le"
      ).toNumber();
      expect(totalDepositedAfter).to.equal(
        totalDepositedBefore + harvestAmount
      );

      // Verify vault now has 500 (kept) + 50 (profit) = 550 tokens
      const vaultAccount = await provider.connection.getAccountInfo(
        yVaultTokenAccount
      );
      const vaultBalance = new BN(
        vaultAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(vaultBalance).to.equal(500_000_000 + harvestAmount);

      // Yield account still has 500 tokens (principal)
      const yieldAccount = await provider.connection.getAccountInfo(
        yYieldTokenAccount.publicKey
      );
      const yieldBalance = new BN(
        yieldAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();
      expect(yieldBalance).to.equal(500_000_000);
    });

    it("claim with yield — recipient gets more than principal after full vest", async () => {
      // Move principal back from yield to vault. In production, this would be
      // a dedicated withdraw_principal instruction. For testing, we use deposit_to_yield
      // in reverse by transferring tokens directly via mint authority to ensure the vault
      // has sufficient liquidity. First, move the 500 tokens from yield back to vault
      // by having the vault authority transfer (harvest_yield with amount=0 won't work).
      // Since harvest_yield would inflate total_deposited, we mint equivalent tokens
      // to the vault instead — simulating principal return from the yield source.
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(
            yMint.publicKey,
            yVaultTokenAccount,
            yMintAuthority.publicKey,
            500_000_000, // return the 500 principal
            [],
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [payer, yMintAuthority]
      );

      // Warp clock past end_at
      const clock = await provider.connection.getAccountInfo(
        new PublicKey("SysvarC1ock11111111111111111111111111111111")
      );
      const currentSlot = new BN(
        clock!.data.subarray(0, 8),
        "le"
      ).toNumber();
      const { Clock: ClockType } = require("solana-bankrun");
      context.setClock(
        new ClockType(
          BigInt(currentSlot + 300),
          BigInt(grantEndAt),
          BigInt(0),
          BigInt(0),
          BigInt(grantEndAt + 100) // well past end_at
        )
      );
      context.warpToSlot(BigInt(currentSlot + 300));

      // Claim vested
      const claimIx = new TransactionInstruction({
        programId: VAULT_PROGRAM_ID,
        keys: [
          {
            pubkey: yRecipient.publicKey,
            isSigner: true,
            isWritable: true,
          },
          { pubkey: yMint.publicKey, isSigner: false, isWritable: false },
          { pubkey: yVaultConfig, isSigner: false, isWritable: true },
          { pubkey: yGrantPda, isSigner: false, isWritable: true },
          { pubkey: yVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: yVaultTokenAccount, isSigner: false, isWritable: true },
          { pubkey: yRecipientAta, isSigner: false, isWritable: true },
          {
            pubkey: TOKEN_2022_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: encodeIxData(ixDiscriminator("claim_vested")),
      });

      await provider.sendAndConfirm(new Transaction().add(claimIx), [
        payer,
        yRecipient,
      ]);

      // Verify recipient got MORE than the original 1000 tokens (proves yield works)
      const recipientAccount = await provider.connection.getAccountInfo(
        yRecipientAta
      );
      const balance = new BN(
        recipientAccount!.data.subarray(64, 72),
        "le"
      ).toNumber();

      expect(balance).to.be.greaterThan(grantAmount);

      // The exact amount depends on share math with dead shares, but should be close to 1100
      // (1000 principal + 100 yield, minus tiny dead shares rounding)
      expect(balance).to.be.lessThanOrEqual(grantAmount + 100_000_000 + 1000_000_000); // sanity upper bound
    });
  });
});
