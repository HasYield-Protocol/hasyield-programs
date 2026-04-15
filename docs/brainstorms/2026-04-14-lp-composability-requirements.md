---
date: 2026-04-14
topic: lp-position-composability
---

# HasYield — LP Position Composability Layer

## Problem Frame

Concentrated liquidity positions on Solana (Meteora DLMM, Orca Whirlpools) are non-transferable PDAs. They earn yield but can't be used as collateral, traded, or composed with other protocols. This is dead composability — billions in LP positions locked in single-purpose accounts.

No protocol on Solana wraps LP positions into composable tokens. Kamino Lend, MarginFi, and Solend only accept fungible tokens. Jupiter Lend rehypothecates fungible assets only. Exponent strips yield from fungible assets only. The gap is real and verified.

**HasYield fills this gap:** Deposit LP liquidity through a vault → get a transferable Token-2022 representation → use it as collateral in lending → earn LP fees + lending yield = flywheel.

## Requirements

**LP Position Vault (Core — On-Chain)**

- R1. Anchor program that CPIs into Meteora DLMM to create and manage LP positions
- R2. Users deposit token pairs (e.g., SOL/USDC) through the vault, which creates a DLMM position owned by the vault PDA
- R3. Vault mints a Token-2022 representation token (hyLP token) representing the user's share of the position
- R4. hyLP token is transferable — uses Transfer Hook for liquidation rights enforcement
- R5. Users can redeem hyLP tokens to withdraw their LP position + accumulated fees
- R6. Vault can claim DLMM fees on behalf of all depositors and distribute proportionally

**Simple Lending Pool (On-Chain)**

- R7. Basic lending pool where hyLP tokens are accepted as collateral
- R8. Users deposit hyLP as collateral → borrow SOL or USDC
- R9. Collateral value = underlying LP position value (token amounts at current price)
- R10. LTV ratio based on range width — wider range = higher LTV (lower IL risk)
- R11. Simple interest rate model (flat or utilization-based)
- R12. Repay loan → withdraw collateral. No auto-liquidation needed for MVP.

**Frontend — Cinematic Demo Experience**

- R13. Landing page tells the story: "Your LP position earns yield. Now unlock it."
- R14. Deposit flow: select pool → choose range → deposit → receive hyLP token
- R15. Dashboard: show LP position value, fees earned, hyLP balance, lending status
- R16. Borrow flow: deposit hyLP as collateral → borrow USDC/SOL
- R17. Position NFT card: visual representation of the wrapped LP position with live fee counter
- R18. The UI must be the wow factor — premium dark/cream design, animations, real-time data

**Transfer Hook (Reuse existing)**

- R19. Enforce that hyLP tokens can't be transferred while used as collateral (prevents collateral flight)
- R20. Allow free transfer when not collateralized

## Success Criteria

- A user can deposit SOL/USDC into a Meteora DLMM pool through HasYield on devnet
- The user receives a hyLP token representing their position
- The user can deposit hyLP as collateral and borrow against it
- The user can see LP fees accruing in real-time
- A judge understands the flywheel in 30 seconds
- The demo works end-to-end on devnet without errors

## Scope Boundaries

- Target Meteora DLMM only (not Orca, not DAMM v2) — one DEX done well
- No auto-liquidation bot — manual repay only for MVP
- No oracle integration — use on-chain token amounts for collateral valuation
- No multi-position per user — one position per deposit for simplicity
- Single pool for demo (e.g., SOL/USDC)
- Keep the existing cinematic UI design system (cream/dark, animations)

## Key Decisions

- **Meteora DLMM over DAMM v2**: DLMM has concentrated liquidity (higher yields, more interesting). DAMM v2 has NFT positions but is constant-product (boring). The wrapping challenge of DLMM is what makes this novel.
- **Build our own lending pool**: No existing Solana lending protocol accepts LP tokens. Building a simple one is faster than trying to integrate with one that can't support our collateral type.
- **hyLP as Token-2022**: Transfer Hook enforces collateral lockup. When hyLP is deposited as collateral, the hook prevents transfer until loan is repaid.
- **Keep HasYield brand**: "Your LP position Has Yield — now unlock it." Logo and design system carry over.
- **Wide range = higher LTV**: Simple risk model. Wider range positions have lower IL risk, so they get better borrowing terms. This is a novel risk parameter.

## Outstanding Questions

### Deferred to Planning
- [Affects R1-R2][Technical] Exact DLMM pool to target on devnet — need to verify SOL/USDC pool exists with sufficient liquidity
- [Affects R3][Technical] hyLP token mint — one per pool or one global mint with metadata?
- [Affects R9-R10][Technical] How to calculate LP position value on-chain without an oracle
- [Affects R6][Technical] Fee distribution mechanism — pro-rata based on shares or per-claim

## Next Steps

→ `/ce:plan` for structured implementation planning
