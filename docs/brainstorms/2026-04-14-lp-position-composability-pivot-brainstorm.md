---
date: 2026-04-14
topic: lp-position-composability-pivot
---

# HasYield Pivot — LP Position Composability Layer

## Context

Original project: vesting + compliance + yield via Transfer Hooks. Working on devnet but weak narrative — "compliance first tokens" doesn't solve a problem users want solved. Yield-on-vesting is a feature Streamflow can add.

**Pivot insight:** Nobody on Solana wraps LP positions into composable, collateralizable tokens. DLMM positions are non-transferable PDAs — locked capital. The same "dead capital" problem, but for LPs instead of vesting.

## Research Findings (verified)

- Meteora DLMM positions = non-transferable PDAs, can't be used as collateral
- No Solana protocol accepts LP positions as lending collateral
- Meteora has full CPI support via `declare_program!` (IDL public)
- PDA-owned positions work via `initialize_position_pda`
- Jupiter Lend does rehypothecation on fungible tokens only
- Exponent does yield stripping on fungible assets only
- **Nobody has built a vault-to-DLMM CPI integration. This would be first.**

## Existing Code Reusable

- Transfer Hook program → enforce liquidation rights on representation token
- Vault math (share-based, dead shares, exchange rate) → LP position share accounting
- Position NFT → representation token for LP positions
- Frontend components (NFT card, yield counter, compliance gate) → adapts to LP context
- Cream/dark UI design system → keeps working

## Open Questions for Brainstorm

- What's the exact product scope for 27 days?
- How does liquidation work?
- What lending protocol do we integrate with (or build our own simple one)?
- Do we target DLMM specifically or also Orca Whirlpools?
- How do we handle impermanent loss risk for collateral?
- What's the demo flow for judges?
