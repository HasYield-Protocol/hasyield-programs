# HasYield Programs

[![Built on Solana](https://img.shields.io/badge/Built%20on-Solana-9945FF?style=flat-square&logo=solana)](https://solana.com)
[![Token-2022](https://img.shields.io/badge/Token--2022-hyLP%20Token-14F195?style=flat-square)](https://spl.solana.com/token-2022)
[![Anchor](https://img.shields.io/badge/Anchor-0.31-blue?style=flat-square)](https://www.anchor-lang.com/)
[![Meteora](https://img.shields.io/badge/Meteora-DLMM-orange?style=flat-square)](https://meteora.ag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

> **"Every position has yield. Now unlock it."**

Anchor programs for HasYield — the first LP position composability layer on Solana. Concentrated liquidity bin rehypothecation: DLMM bins earn trading fees while SOL routes to staking and USDC routes to lending markets. Triple yield on the same capital.

## The Problem

Concentrated liquidity positions on Solana (Meteora DLMM) are **non-transferable PDAs**. They earn trading fees but:

- Can't be used as **collateral** in lending protocols
- Can't be **traded** or transferred to another wallet
- Can't be **composed** with other DeFi protocols
- The SOL and USDC inside bins sit **idle** — earning fees but not staking or lending yield

No protocol on Solana wraps LP positions into composable tokens.

## Architecture

```
┌──────────────────────┐ ┌──────────────────────────┐
│   LP Vault Program   │ │   Lending Pool Program   │
│                      │ │                          │
│ • deposit_liquidity  │ │ • deposit_collateral     │
│ • withdraw_liquidity │ │ • borrow                 │
│ • simulate_fees      │ │ • repay                  │
│                      │ │ • withdraw_collateral    │
│ Mints hyLP tokens    │ │                          │
│ (Token-2022)         │ │ hyLP as collateral       │
└──────────┬───────────┘ └──────────────────────────┘
           │ CPI
           ▼
┌──────────────────────┐ ┌──────────────────────────┐
│  Meteora DLMM        │ │  Transfer Hook Program   │
│                      │ │                          │
│ • add_liquidity      │ │ • Collateral lockup      │
│ • remove_liquidity   │ │ • Block transfer while   │
│ • claim_fee          │ │   borrowed against       │
└──────────────────────┘ └──────────────────────────┘
```

### Programs

| Program | Description | Address (Devnet) |
|---------|-------------|-----------------|
| **LP Vault** | Deposits into Meteora DLMM, mints hyLP Token-2022 shares | `BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T` |
| **Lending Pool** | Accepts hyLP as collateral, enables SOL/USDC borrowing (50% LTV) | `J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf` |
| **Transfer Hook** | Enforces collateral lockup — blocks hyLP transfer while borrowed against | `EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM` |

### Triple Yield Flywheel

```
Deposit SOL + USDC → HasYield Vault → Meteora DLMM bins
                                           │
                     ┌─────────────────────┼─────────────────────┐
                     │                     │                     │
                LP Trading Fees      SOL → Staking          USDC → Lending
                (30-60% APY)        (~7% APY)              (~12% APY)
                     │                     │                     │
                     └─────────────────────┼─────────────────────┘
                                           │
                                Triple Yield: up to ~79% APY
```

## Why Solana

- **Token-2022 Transfer Hooks** enforce collateral lockup at the token level — not via wrapper contracts
- **Meteora DLMM** bins are Solana-native concentrated liquidity with CPI support
- **Composability** — hyLP tokens work across the entire Solana DeFi ecosystem

## Getting Started

### Prerequisites

- Rust 1.75+
- Solana CLI 2.2+
- Anchor CLI 0.31+
- Node.js 18+

### Build & Deploy

```bash
# Install dependencies
npm install

# Build programs
cargo build-sbf --manifest-path programs/lp-vault/Cargo.toml
cargo build-sbf --manifest-path programs/lending/Cargo.toml
cargo build-sbf --manifest-path programs/transfer-hook/Cargo.toml

# Deploy to devnet
solana program deploy target/deploy/lp_vault.so --url devnet
solana program deploy target/deploy/lending.so --url devnet
solana program deploy target/deploy/transfer_hook.so --url devnet

# Setup LP vault on devnet
npx ts-node scripts/setup-lp-vault.ts

# Run E2E test
npx ts-node scripts/e2e-test.ts
```

## Hackathon

**Colosseum Solana Frontier** (Apr 6 — May 11, 2026) | Track: DeFi

## License

MIT
