# HasYield Programs

## What This Is

Anchor programs for HasYield — concentrated liquidity bin rehypothecation on Solana. DLMM bins earn trading fees while SOL routes to staking and USDC routes to lending. Triple yield on the same capital.

**Hackathon:** Colosseum Solana Frontier (Apr 6 — May 11, 2026)
**Track:** DeFi
**Org:** https://github.com/HasYield-Protocol
**Frontend repo:** https://github.com/HasYield-Protocol/hasyield-app

## Programs

| Program | Address (Devnet) | Description |
|---------|-----------------|-------------|
| LP Vault | `BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T` | Deposits into real Meteora DLMM via CPI, routes SOL to Marinade, mints hyLP Token-2022 shares |
| Lending Pool | `J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf` | Accepts hyLP as collateral, enables USDC borrowing |
| Transfer Hook | `EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM` | Blocks hyLP transfer while collateralized |

## Real CPI Integrations

| Protocol | CPI Type | Instruction | Status |
|----------|----------|-------------|--------|
| **Meteora DLMM** | `invoke_signed` | `add_liquidity_by_strategy`, `remove_liquidity_by_range`, `claim_fee` | **Proven on devnet** |
| **Marinade Finance** | `invoke_signed` | `deposit` (SOL→mSOL), `liquid_unstake` (mSOL→SOL) | **Proven on devnet** |
| **Solend** | `invoke_signed` | `deposit_reserve_liquidity`, `redeem_reserve_collateral` | Code deployed, needs devnet reserve |

## Key Addresses (Devnet)

- Deployer wallet: `7LwYZRf5BAiHXNCMyngir3uYEX9XhaGYm4udoPK7CPhq`
- Vault config PDA: `5hAGZFirTf7yB9MAfF4MN2iyQ89xDjSewymBAJ5gKZ21`
- Vault Authority PDA: `9t6Zv8xtZrogbZL44EqdXknNHgron5MTdtSvTHww1vpc`
- hyLP Mint: `58WoS25fsv2Pod6LkcuvrsF5p19YFfavmaAJAjRuvvMF`
- DLMM Position: `F3uAc3cjmyRQAvDae2DygXHmmKowhPhZmtzqb1yEanGg`
- DLMM Pool (USDC/SOL): `EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE`
- USDC Devnet Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Lending Pool: `AGWpvCjV3sHwkNWLtyT2837URzWmGNGffa5W4eYg1kHR`
- Vault mSOL ATA: `BhEC5GeSJxgCu4c3w2eZzvm6f5tAwdR8nWTKAtQiTR6B`

## Technical Notes

- LP vault uses TWO token programs: TOKEN_PROGRAM_ID for SOL/USDC, TOKEN_2022_PROGRAM_ID for hyLP mint/burn
- Share-based vault math (ERC4626-style) with dead shares anti-inflation
- 50% LTV lending pool with flat 5% APR interest
- DLMM CPI uses raw `invoke_signed` with discriminators from IDL
- Pool token order: X = USDC (6 decimals), Y = SOL (9 decimals)
- Position range: bins -34 to 34 (69 bins, centered on active_id=0)
- Bin array PDAs must use two's complement i64 LE for negative indices
- SpotImBalanced strategy (variant 6) with parameteres[0]=favorSide for single-token deposits
- Marinade deposit: vault_authority PDA transfers SOL to Marinade, receives mSOL
- 30% of deposited SOL routes to Marinade staking

## Commands

```bash
# Build all
cargo build-sbf --manifest-path programs/lp-vault/Cargo.toml
cargo build-sbf --manifest-path programs/lending/Cargo.toml
cargo build-sbf --manifest-path programs/transfer-hook/Cargo.toml

# Deploy
solana program deploy target/deploy/lp_vault.so --url devnet --program-id BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T

# E2E test (full DLMM CPI flow)
ts-node scripts/e2e-test.ts

# Marinade staking test
ts-node scripts/test-marinade.ts
```
