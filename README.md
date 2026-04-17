# HasYield — Concentrated Liquidity Rehypothecation

[![Built on Solana](https://img.shields.io/badge/Built%20on-Solana-9945FF?style=flat-square&logo=solana)](https://solana.com)
[![Anchor 0.31](https://img.shields.io/badge/Anchor-0.31-blue?style=flat-square)](https://www.anchor-lang.com/)
[![Meteora DLMM](https://img.shields.io/badge/Meteora-DLMM%20CPI-orange?style=flat-square)](https://meteora.ag)
[![Marinade](https://img.shields.io/badge/Marinade-Staking%20CPI-teal?style=flat-square)](https://marinade.finance)

**One deposit. Three yield sources. All on-chain CPI.**

HasYield wraps Meteora DLMM concentrated liquidity positions into composable hyLP tokens (Token-2022), then rehypothecates the underlying capital across staking and lending protocols — earning triple yield from the same deposit.

## How Rehypothecation Works

The key insight: when you deposit SOL into a DLMM pool, that SOL sits in discrete price bins. Between trades, it's idle capital. HasYield routes that idle capital to yield-generating protocols while maintaining the DLMM position.

### Step-by-step flow

```
User deposits 1 SOL
       │
       ▼
┌─────────────────────────────────────────────────────┐
│                  HasYield Vault PDA                  │
│                                                     │
│  The vault PDA acts as a unified account that owns  │
│  positions across multiple protocols simultaneously │
└───────────┬──────────────┬──────────────────────────┘
            │              │
     ┌──────▼──────┐  ┌───▼────────────────┐
     │  70% → DLMM │  │  30% → Marinade    │
     │             │  │                    │
     │ CPI to      │  │ CPI to             │
     │ Meteora     │  │ MarBmsSgKX...      │
     │ LBUZKhRx... │  │                    │
     │             │  │ deposit(lamports)   │
     │ add_liquidity│  │    → receive mSOL  │
     │ _by_strategy │  │                    │
     │             │  │ Vault PDA now       │
     │ SOL goes    │  │ holds mSOL that     │
     │ into bins   │  │ appreciates ~7% APY │
     │ around the  │  │                    │
     │ active      │  └────────────────────┘
     │ price       │
     │             │
     │ Earns LP    │
     │ trading     │
     │ fees when   │
     │ swaps cross │
     │ these bins  │
     └─────────────┘

User receives: hyLP tokens (Token-2022) representing their share of the vault
```

### What makes this rehypothecation, not just "multi-protocol farming"

**Traditional approach:** User deposits SOL to Protocol A, gets receipt token, deposits receipt to Protocol B. Each protocol sees different collateral. Capital is split.

**HasYield approach:** The vault PDA owns ALL positions. It deposits the SAME SOL to Meteora DLMM for LP fees AND routes a portion to Marinade for staking yield. The user holds a single hyLP token representing their share of everything. The capital is rehypothecated — used in multiple protocols simultaneously through one unified vault.

The vault PDA (`9t6Zv8xtZrogbZL44EqdXknNHgron5MTdtSvTHww1vpc`) is:
- The **owner** of the Meteora DLMM position
- The **depositor** into Marinade Finance
- The **token authority** for vault token accounts
- The **mint authority** for hyLP tokens

One PDA, three protocols, all via CPI.

### Yield sources explained

| Source | Protocol | How it works | CPI instruction |
|--------|----------|-------------|-----------------|
| **LP Trading Fees** | Meteora DLMM | SOL+USDC placed in concentrated bins. When trades cross these price ranges, the vault earns swap fees. Claimed via `claim_fee` CPI. | `add_liquidity_by_strategy` → `claim_fee` |
| **Staking Yield** | Marinade Finance | 30% of deposited SOL routes to Marinade's liquid staking pool. Vault receives mSOL which appreciates in value as validators earn rewards. | `deposit` (SOL→mSOL) |
| **Lending Yield** | HasYield Lending / Solend (future) | USDC routes to lending pool where borrowers pay interest. Currently uses HasYield's own lending pool; Solend CPI code deployed for future integration. | `deposit_reserve_liquidity` |

### The hyLP token

hyLP is a **Token-2022** token with a **Transfer Hook**. This enables:

- **Composability** — hyLP can be transferred, traded, or used in other protocols
- **Collateral lockup** — when hyLP is deposited as collateral in the lending pool, the transfer hook blocks transfers until the loan is repaid
- **Share-based accounting** — hyLP uses ERC4626-style vault math. As fees accrue, each hyLP becomes worth more SOL+USDC

```
hyLP value = (total_deposited_x + total_deposited_y + accrued_fees) / total_shares
```

### Borrowing against LP positions

With hyLP as a composable token, users can deposit it as collateral to borrow USDC:

```
User has hyLP  →  deposit_collateral (hyLP → lending pool)
                       │
                       ▼
              Transfer Hook blocks
              hyLP transfers (locked)
                       │
                       ▼
              borrow(amount) → receive USDC
              (up to 50% LTV)
                       │
                       ▼
              Position STILL earns LP fees,
              staking yield, lending yield
              while collateralized
                       │
                       ▼
              repay(amount) → return USDC
                       │
                       ▼
              withdraw_collateral → hyLP unlocked
```

This is the full rehypothecation flywheel: deposit once, earn triple yield, borrow against it without unstaking.

## Architecture

### Programs

| Program | Address (Devnet) | Role |
|---------|-----------------|------|
| **LP Vault** | `BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T` | Core vault — DLMM CPI, Marinade CPI, Solend CPI, hyLP mint/burn |
| **Lending Pool** | `J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf` | hyLP collateral, USDC borrowing, 50% LTV, 5% APR |
| **Transfer Hook** | `EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM` | Collateral lockup enforcement via Token-2022 |

### External protocol CPIs

| Protocol | Program ID | CPI Method | Devnet Status |
|----------|-----------|------------|---------------|
| **Meteora DLMM** | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Raw `invoke_signed` with IDL discriminators | **Proven** — deposit/withdraw/claim fees |
| **Marinade Finance** | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | Raw `invoke_signed` with Anchor discriminators | **Proven** — SOL→mSOL staking |
| **Solend** | `ALend7Ketfx5bxh6ghsCDXAoDrhvEmsXT3cynB6aPLgx` | Raw `invoke_signed` with SPL tag bytes | Code deployed, devnet reserve pending |

All CPIs use `invoke_signed` with the vault PDA as signer — no external crate dependencies, no `declare_program!`. The vault constructs instruction data from known discriminators and serializes arguments directly.

### Key design decisions

**Raw CPI over declare_program!** — Avoids Anchor version mismatches between our program (0.31) and external programs (various versions). The IDL discriminators are stable; the CPI is just bytes.

**SpotImBalanced strategy for single-sided deposits** — When a user deposits only SOL (no USDC), the vault uses Meteora's `SpotImBalanced` strategy (variant 6) with `parameteres[0] = 0` (favor Y side). This places liquidity in bins below the active price, matching how the Meteora SDK handles single-sided deposits.

**Two's complement bin array PDAs** — Negative bin IDs (e.g., bin -34) require `i64` two's complement encoding in PDA seeds, not unsigned `BN.toArrayLike()`. This was a critical bug that caused silent PDA mismatches.

**Vault authority as universal signer** — One PDA signs for DLMM position ownership, Marinade deposits, Solend deposits, and hyLP mint authority. This is what enables rehypothecation — the vault is a single entity across all protocols.

## Getting Started

### Prerequisites

- Rust 1.75+ / Solana CLI 2.2+ / Anchor 0.31+ / Node.js 18+

### Build & Test

```bash
npm install

# Build
cargo build-sbf --manifest-path programs/lp-vault/Cargo.toml
cargo build-sbf --manifest-path programs/lending/Cargo.toml

# Deploy to devnet
solana program deploy target/deploy/lp_vault.so --url devnet \
  --program-id BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T

# Full E2E test (DLMM deposit → claim fees → withdraw)
ts-node scripts/e2e-test.ts

# Marinade staking test (SOL → mSOL via vault PDA)
ts-node scripts/test-marinade.ts
```

### Frontend

See [hasyield-app](https://github.com/HasYield-Protocol/hasyield-app) — Next.js 16 vault dashboard with real wallet transactions.

## Devnet Addresses

| Account | Address |
|---------|---------|
| Vault Config | `5hAGZFirTf7yB9MAfF4MN2iyQ89xDjSewymBAJ5gKZ21` |
| Vault Authority | `9t6Zv8xtZrogbZL44EqdXknNHgron5MTdtSvTHww1vpc` |
| hyLP Mint | `58WoS25fsv2Pod6LkcuvrsF5p19YFfavmaAJAjRuvvMF` |
| DLMM Position | `F3uAc3cjmyRQAvDae2DygXHmmKowhPhZmtzqb1yEanGg` |
| DLMM Pool | `EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE` |
| Lending Pool | `AGWpvCjV3sHwkNWLtyT2837URzWmGNGffa5W4eYg1kHR` |
| Vault mSOL | `BhEC5GeSJxgCu4c3w2eZzvm6f5tAwdR8nWTKAtQiTR6B` |

## Roadmap

- [x] Meteora DLMM CPI — real concentrated liquidity
- [x] Marinade staking CPI — SOL→mSOL yield
- [x] hyLP Token-2022 with transfer hook
- [x] Lending pool with collateral/borrow/repay
- [x] Frontend with wallet integration
- [ ] Solend/Kamino lending CPI (code deployed, needs devnet reserve)
- [ ] Auto-rebalance — AI-driven yield optimization across protocols
- [ ] Multi-pool support (SOL/USDT, ETH/USDC, JUP/USDC)
- [ ] Yield tokenization (PT/YT split)

## Hackathon

**Colosseum Solana Frontier** (Apr 6 — May 11, 2026) | Track: DeFi

## License

MIT
