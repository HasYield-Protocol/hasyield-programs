# HasYield — Quickstart Guide

## Prerequisites

```bash
solana --version   # 2.2+
anchor --version   # 0.31+
node --version     # 18+
```

Wallet configured for devnet:
```bash
solana config set --url devnet
solana balance     # need ~2 SOL
```

## 1. Build Programs

```bash
cargo build-sbf --manifest-path programs/lp-vault/Cargo.toml
cargo build-sbf --manifest-path programs/lending/Cargo.toml
```

## 2. Deploy to Devnet

```bash
solana program deploy target/deploy/lp_vault.so \
  --program-id target/deploy/lp_vault-keypair.json --url devnet

solana program deploy target/deploy/lending.so \
  --program-id target/deploy/lending-keypair.json --url devnet
```

## 3. Run E2E Test

This initializes the vault, deposits, simulates fees, and sets up the lending pool:

```bash
npx ts-node scripts/e2e-test.ts
```

Expected output:
```
═══════════════════════════════════════════════════
HasYield E2E Test
═══════════════════════════════════════════════════
Payer: 7LwYZR...

── Step 1: LP Vault ──
✓ Vault initialized / already initialized

── Step 2: Deposit ──
  Wrapping SOL...
  Depositing 1 USDC + 0.01 SOL...
✓ Deposit success

── Step 3: Simulate Fees ──
✓ Fees simulated (exchange rate boosted)

── Step 4: Lending Pool ──
✓ Lending pool initialized

═══════════════════════════════════════════════════
E2E TEST COMPLETE
═══════════════════════════════════════════════════
```

## 4. Run Frontend

See [hasyield-app](https://github.com/HasYield-Protocol/hasyield-app) repo.

## Program Addresses (Devnet)

| Program | Address |
|---------|---------|
| LP Vault | `BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T` |
| Lending | `J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf` |
| Transfer Hook | `EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM` |
| DLMM Pool (SOL/USDC) | `EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE` |
| USDC Devnet Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Architecture

See the [architecture diagram](https://github.com/HasYield-Protocol/hasyield-app/blob/main/public/architecture.html) in the app repo.

## Troubleshooting

**"Insufficient funds"** → Airdrop SOL: `solana airdrop 2 --url devnet`

**"Vault already initialized"** → The vault was created with old PDA seeds. Close and re-init:
```bash
# Close old vault config account (recover rent)
solana account 5hAGZFirTf7yB9MAfF4MN2iyQ89xDjSewymBAJ5gKZ21 --url devnet
# Re-run setup
npx ts-node scripts/e2e-test.ts
```

**"Account not found"** → Make sure you have USDC on devnet. Get from a faucet or the test wallet `8ku1gytH4qw8SJqeYeRJ2xkqEh1XQPpZAQ5vvRKbUBXu`.
