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
| LP Vault | `BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T` | Deposits into DLMM, mints hyLP Token-2022 shares |
| Lending Pool | `J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf` | Accepts hyLP as collateral, enables SOL/USDC borrowing |
| Transfer Hook | `EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM` | Blocks hyLP transfer while collateralized |

## Key Addresses (Devnet)

- Deployer wallet: `7LwYZRf5BAiHXNCMyngir3uYEX9XhaGYm4udoPK7CPhq`
- Test user wallet: `8ku1gytH4qw8SJqeYeRJ2xkqEh1XQPpZAQ5vvRKbUBXu`
- Vault config PDA: `EDKpihQ98wgB7L865izMuRnvxoBw5syVpzwtbwBzJmzd`
- hyLP Mint: `EBdngGBEcYFe4dD7Jtk2nPLqwhmC7ud3tkYTdkHFJTRJ`
- DLMM Pool (SOL/USDC): `EUcPNLCoVFb4YTM87m4Kudv3PAG71k5wGxy2Pug5YknE`
- USDC Devnet Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

## Technical Notes

- LP vault uses TWO token programs: TOKEN_PROGRAM_ID for SOL/USDC, TOKEN_2022_PROGRAM_ID for hyLP mint/burn
- Share-based vault math (ERC4626-style) with dead shares anti-inflation
- 50% LTV lending pool with range-based risk (wider LP range = safer collateral)
- Old vault configs with (USDC/SOL order) have stale PDA bumps — use SOL/TEST_TOKEN or create fresh pairs

## What's Working

- E2E test passing: `npx ts-node scripts/e2e-test.ts` — deposit SOL → receive hyLP → lending pool init
- All 3 programs deployed to devnet

## What's TODO

1. Fix simulate_fees in E2E test (wrong mint accounts passed)
2. Test borrow/repay flow E2E on devnet
3. Real Meteora DLMM CPI integration (currently simulated)
4. Kamino Lend devnet integration (staging program: `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh`)

## Commands

```bash
# Build
cargo build-sbf --manifest-path programs/lp-vault/Cargo.toml
cargo build-sbf --manifest-path programs/lending/Cargo.toml

# Deploy
solana program deploy target/deploy/lp_vault.so --url devnet
solana program deploy target/deploy/lending.so --url devnet

# Setup + E2E test
npx ts-node scripts/setup-lp-vault.ts
npx ts-node scripts/e2e-test.ts
```
