---
title: "feat: LP position composability — DLMM vault, hyLP token, lending pool"
type: feat
status: active
date: 2026-04-14
origin: docs/brainstorms/2026-04-14-lp-composability-requirements.md
---

# LP Position Composability — HasYield Pivot

## Overview

Pivot HasYield from vesting+compliance to LP position composability. Users deposit token pairs into Meteora DLMM pools through a HasYield vault, receive transferable hyLP tokens (Token-2022), and can use those tokens as collateral to borrow against their LP position. The flywheel: LP fees + borrowing power on the same capital.

## Problem Frame

Concentrated liquidity positions on Solana are non-transferable PDAs. They earn yield but can't be used as collateral, traded, or composed with other protocols. No Solana protocol wraps LP positions into composable tokens. HasYield fills this gap. (see origin: docs/brainstorms/2026-04-14-lp-composability-requirements.md)

## Requirements Trace

- R1. Anchor program CPIs into Meteora DLMM to manage positions
- R2. Users deposit token pairs through vault → vault creates DLMM position
- R3. Vault mints hyLP Token-2022 representing user's share
- R4. hyLP transferable with Transfer Hook enforcing collateral lockup
- R5. Users redeem hyLP → withdraw LP position + fees
- R6. Vault claims DLMM fees, distributes proportionally via share math
- R7-R12. Simple lending pool: hyLP as collateral, borrow SOL/USDC
- R13-R18. Frontend: cinematic demo, deposit/borrow flows, position NFT card
- R19-R20. Transfer Hook: block transfer when collateralized, allow when free

## Scope Boundaries

- Meteora DLMM only (not Orca, not DAMM v2)
- No auto-liquidation bot — manual repay for MVP
- No oracle — collateral value = deposited token amounts
- One position per deposit
- Single SOL/USDC pool on devnet
- Keep existing cream/dark UI design system

## Context & Research

### Relevant Code and Patterns

- `programs/vault/src/lib.rs` — share-based math (ERC4626-style), PDA signer pattern, remaining_accounts passthrough. All reusable.
- `programs/transfer-hook/src/lib.rs` — compliance checks, ExtraAccountMeta setup. Reuse 100% as-is, add collateral lock check.
- Meteora DLMM IDL at `MeteoraAg/cpi-examples/idls/dlmm.json` — use `declare_program!` macro for CPI
- `@meteora-ag/dlmm` npm package — TypeScript SDK for pool creation and position management
- DLMM Program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (deployed on devnet)

### External References

- [Meteora CPI examples](https://github.com/MeteoraAg/cpi-examples) — Anchor 0.28 but pattern applies
- [DLMM TypeScript SDK](https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/getting-started)
- [Meteora DLMM Integration](https://docs.meteora.ag/integration/dlmm-integration)

## Key Technical Decisions

- **Rework vault program, don't create new**: The existing vault has share math, PDA signer, remaining_accounts passthrough — all needed. Replace vesting-specific instructions with LP-specific ones. Keep the program ID.
- **One hyLP mint per DLMM pool**: Clean accounting, matches how LP tokens work. Mint created during vault initialization.
- **Collateral value = deposited amounts (no oracle)**: For MVP, over-collateralize by default. Ignoring IL simplifies the program. Real oracle integration is roadmap.
- **Fee distribution via share exchange rate**: When DLMM fees are claimed, they increase `total_deposited`. Share holders benefit proportionally. Same pattern as current vault.
- **Lending pool as separate program**: Keeps vault and lending concerns separate. Lending program holds collateral (hyLP) and manages loans.
- **Create own DLMM pool on devnet**: No pre-seeded pools exist. Setup script creates SOL/USDC pool via TypeScript SDK.

## Open Questions

### Resolved During Planning

- **DLMM devnet pools**: No pre-seeded pools. We create our own SOL/USDC pool via `@meteora-ag/dlmm` SDK in a setup script.
- **hyLP mint strategy**: One mint per pool, created during `initialize_lp_vault`. Seeds: `["hylp-mint", lb_pair]`.
- **Position value**: Collateral value = sum of deposited tokens. No IL adjustment for MVP.
- **Anchor version compatibility**: CPI examples use Anchor 0.28 but `declare_program!` works in 0.31. We use the IDL directly.

### Deferred to Implementation

- Exact bin range strategy for the demo pool (wide range, single-bin, or multi-bin)
- Whether `remaining_accounts` passthrough is sufficient for DLMM CPI or if explicit accounts are needed
- Exact DLMM IDL fields needed — resolve by reading the full IDL during implementation
- Frontend pool selection UI — may be hardcoded to demo pool for MVP

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                       │
│  Deposit SOL/USDC → See hyLP balance → Borrow against it   │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
┌──────────────────────┐ ┌──────────────────────────┐
│   LP Vault Program   │ │   Lending Pool Program   │
│                      │ │                          │
│ • deposit_liquidity  │ │ • deposit_collateral     │
│   → CPI to DLMM     │ │   (locks hyLP)           │
│   → mint hyLP        │ │ • borrow                 │
│ • withdraw_liquidity │ │   (sends SOL/USDC)       │
│   → burn hyLP        │ │ • repay                  │
│   → CPI remove_liq   │ │   (unlocks hyLP)         │
│ • claim_fees         │ │                          │
│   → CPI claim_fee    │ │ LTV based on range width │
│   → boost shares     │ │                          │
└──────────┬───────────┘ └──────────────────────────┘
           │ CPI
           ▼
┌──────────────────────┐
│  Meteora DLMM        │
│  (LBUZKhR...)        │
│                      │
│ • add_liquidity      │
│ • remove_liquidity   │
│ • claim_fee          │
└──────────────────────┘

┌──────────────────────┐
│  Transfer Hook       │
│  (existing, modified)│
│                      │
│ • Check: is hyLP     │
│   collateralized?    │
│   → BLOCK transfer   │
│ • Not collateralized? │
│   → ALLOW transfer   │
└──────────────────────┘
```

## Phased Delivery

### Phase 1: Foundation (Days 1-5)
- Setup: DLMM devnet pool, IDL integration, program scaffolding
- LP Vault core: deposit → DLMM CPI → mint hyLP
- Withdraw: burn hyLP → remove liquidity → return tokens

### Phase 2: Flywheel (Days 6-10)
- Fee claiming: CPI to claim_fee → boost share exchange rate
- Lending pool: deposit collateral, borrow, repay
- Transfer Hook: collateral lock enforcement

### Phase 3: Frontend + Polish (Days 11-20)
- Landing page update (new tagline, new demo flow)
- Deposit/withdraw UI
- Borrow/repay UI
- Position NFT card with live fee counter
- Demo flow for pitch video

### Phase 4: Submission (Days 21-27)
- Pitch video (3 min)
- End-to-end testing
- README + submission materials
- Continue building post-deadline

## Implementation Units

### Phase 1: Foundation

- [ ] **Unit 1: DLMM devnet pool setup + IDL integration**

**Goal:** Create a SOL/USDC DLMM pool on devnet and integrate the DLMM IDL into the Anchor workspace.

**Requirements:** R1 (prerequisite)

**Dependencies:** None

**Files:**
- Create: `scripts/setup-dlmm-pool.ts`
- Create: `idls/dlmm.json` (copy from MeteoraAg/cpi-examples)
- Modify: `programs/vault/Cargo.toml` (add DLMM dependency or IDL path)
- Modify: `Anchor.toml` (add DLMM program ID reference)

**Approach:**
- Use `@meteora-ag/dlmm` TypeScript SDK to create a permissionless SOL/USDC pool on devnet
- Use a wide bin range (e.g., ±50% from current price) for stable demo behavior
- Download DLMM IDL and place in `idls/` directory
- Configure `declare_program!` in vault program to reference the IDL
- Store created pool address in a constants file

**Patterns to follow:**
- `scripts/seed-demo.ts` for devnet script patterns
- `MeteoraAg/cpi-examples` for IDL integration approach

**Test scenarios:**
- Happy path: script creates a pool on devnet and outputs the pool address
- Error path: script fails gracefully if pool already exists
- Integration: DLMM IDL loads correctly in Anchor workspace (`anchor build` succeeds)

**Verification:**
- SOL/USDC DLMM pool exists on devnet with known address
- Vault program compiles with DLMM IDL integrated
- Pool address stored in constants file

---

- [ ] **Unit 2: LP Vault — deposit liquidity + mint hyLP**

**Goal:** Users deposit SOL + USDC through the vault, which CPIs into DLMM to create a position, then mints hyLP tokens to the depositor.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `programs/vault/src/lib.rs` (replace vesting instructions with LP instructions)
- Test: `tests/lp-vault.ts`

**Approach:**
- New state: `LpVaultConfig` — stores `lb_pair`, `hyp_mint`, `total_deposited_x`, `total_deposited_y`, `total_shares`, `position` PDA
- New instruction: `initialize_lp_vault` — creates vault config, creates hyLP mint (Token-2022 with Transfer Hook), creates DLMM position via `initialize_position_pda` CPI
- New instruction: `deposit_liquidity` — takes SOL + USDC from user, CPIs to `add_liquidity_by_strategy` on Meteora, mints proportional hyLP tokens to depositor
- PDA `vault-authority` signs all DLMM CPIs
- Share math: first depositor gets 1:1 shares (minus dead shares). Subsequent depositors get shares proportional to total value.

**Patterns to follow:**
- Existing `shares_for_deposit` / `assets_for_shares` from current vault
- `remaining_accounts` passthrough for DLMM bin arrays
- `CpiContext::new_with_signer` with vault-authority PDA seeds

**Test scenarios:**
- Happy path: deposit 1 SOL + equivalent USDC → receive hyLP tokens → DLMM position created with correct bin range
- Happy path: second deposit → shares minted proportionally to first depositor
- Edge case: deposit with zero amount → error
- Edge case: first depositor gets dead shares deducted
- Integration: DLMM position account exists on-chain after deposit, owned by vault PDA

**Verification:**
- User has hyLP tokens after deposit
- DLMM position exists and contains the deposited liquidity
- Share math is correct for multiple depositors

---

- [ ] **Unit 3: LP Vault — withdraw liquidity + burn hyLP**

**Goal:** Users burn hyLP tokens to withdraw their share of the LP position + accumulated fees.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify: `programs/vault/src/lib.rs`
- Test: `tests/lp-vault.ts`

**Approach:**
- New instruction: `withdraw_liquidity` — burns user's hyLP tokens, calculates proportional share of LP position, CPIs to `remove_liquidity_by_range` on Meteora, transfers withdrawn tokens back to user
- Checks-effects-interactions: burn hyLP and update state before CPI withdraw
- Must calculate how many bins to withdraw from based on share percentage

**Patterns to follow:**
- `claim_vested` from existing vault (checks-effects-interactions pattern)
- `assets_for_shares` for calculating withdrawal amount

**Test scenarios:**
- Happy path: burn all hyLP → withdraw all liquidity → user receives SOL + USDC
- Happy path: burn partial hyLP → withdraw proportional liquidity
- Error path: burn more hyLP than owned → error
- Error path: withdraw while hyLP is collateralized in lending pool → Transfer Hook blocks burn
- Integration: DLMM position liquidity decreases after withdrawal

**Verification:**
- User receives tokens proportional to their share
- DLMM position updated correctly
- Share accounting remains consistent

---

### Phase 2: Flywheel

- [ ] **Unit 4: Fee claiming + share exchange rate boost**

**Goal:** Vault claims accumulated DLMM trading fees and boosts the share exchange rate, making all hyLP holders' positions more valuable.

**Requirements:** R6

**Dependencies:** Unit 2

**Files:**
- Modify: `programs/vault/src/lib.rs`
- Test: `tests/lp-vault.ts`

**Approach:**
- New instruction: `claim_lp_fees` — CPIs to Meteora `claim_fee`, receives token_x and token_y fees into vault token accounts, increases `total_deposited_x` and `total_deposited_y` accordingly
- This increases the exchange rate: existing hyLP holders now redeem for more tokens
- Can be called by anyone (permissionless crank)

**Patterns to follow:**
- `harvest_yield` from existing vault (same concept: external yield → boost deposits)

**Test scenarios:**
- Happy path: after some trading activity, `claim_lp_fees` increases `total_deposited` and exchange rate rises
- Edge case: claim with no accumulated fees → no-op, no error
- Integration: exchange rate before and after claim_lp_fees shows increase

**Verification:**
- Fees claimed from DLMM position
- Share exchange rate increases
- Subsequent withdrawals return more tokens than deposited

---

- [ ] **Unit 5: Simple lending pool program**

**Goal:** New Anchor program where hyLP tokens are deposited as collateral to borrow SOL or USDC.

**Requirements:** R7, R8, R9, R10, R11, R12

**Dependencies:** Unit 2 (hyLP token must exist)

**Files:**
- Create: `programs/lending/src/lib.rs`
- Create: `programs/lending/Cargo.toml`
- Modify: `Anchor.toml` (add lending program)
- Test: `tests/lending.ts`

**Approach:**
- State: `LendingPool` — stores `collateral_mint` (hyLP), `borrow_mint` (SOL or USDC), `total_borrowed`, `total_collateral`, `ltv_bps` (basis points, e.g., 5000 = 50%), `interest_rate_bps`
- State: `LoanPosition` — per-user PDA, stores `collateral_deposited`, `borrowed_amount`, `borrow_timestamp`
- Instructions:
  - `initialize_lending_pool` — creates pool with LTV and interest config
  - `deposit_collateral` — transfers hyLP from user to pool's collateral account. Sets a flag in Transfer Hook compliance so hyLP can't be transferred while collateralized.
  - `borrow` — checks collateral value × LTV ≥ borrow amount, transfers borrow tokens to user
  - `repay` — transfers borrow tokens back, updates loan. When fully repaid, unlocks collateral (clears compliance flag).
  - `withdraw_collateral` — returns hyLP after loan fully repaid
- Collateral value = deposited token amounts (tracked in LP vault config). Simple: just read `LpVaultConfig.total_deposited_x/y` and multiply by user's share percentage.
- No auto-liquidation. If position goes underwater, it stays until manual repay.

**Patterns to follow:**
- Existing vault program structure (state accounts, PDA seeds, error codes)
- `createSetUserComplianceIx` to flag collateralized hyLP in Transfer Hook

**Test scenarios:**
- Happy path: deposit 100 hyLP → borrow 50 USDC (at 50% LTV) → repay 50 USDC → withdraw 100 hyLP
- Error path: borrow exceeding LTV → rejected
- Error path: withdraw collateral while loan outstanding → rejected
- Error path: transfer hyLP while collateralized → Transfer Hook blocks
- Edge case: borrow with zero collateral → rejected

**Verification:**
- Full borrow/repay lifecycle works
- LTV enforcement prevents over-borrowing
- Transfer Hook blocks collateralized hyLP transfers

---

- [ ] **Unit 6: Transfer Hook — collateral lock enforcement**

**Goal:** Modify existing Transfer Hook to check if hyLP tokens are locked as lending collateral, blocking transfers if so.

**Requirements:** R19, R20

**Dependencies:** Unit 5

**Files:**
- Modify: `programs/transfer-hook/src/lib.rs`
- Test: `tests/transfer-hook.ts`

**Approach:**
- Add a `collateral_locked` field to `UserCompliance` struct
- In `transfer_hook` handler: if source wallet's `collateral_locked` is true, reject transfer
- Lending program CPIs to `set_user_compliance` to set/clear the `collateral_locked` flag
- Preserves existing KYC/lockup/holder cap checks

**Patterns to follow:**
- Existing `set_user_compliance` instruction and `UserCompliance` struct

**Test scenarios:**
- Happy path: transfer hyLP when not collateralized → allowed
- Happy path: transfer hyLP when collateralized → blocked with clear error
- Happy path: repay loan → clear collateral lock → transfer now allowed
- Integration: deposit collateral in lending → try to transfer → blocked by Transfer Hook

**Verification:**
- Collateral lock prevents hyLP transfers
- Clearing the lock re-enables transfers

---

### Phase 3: Frontend + Polish

- [ ] **Unit 7: Landing page update + deposit/withdraw UI**

**Goal:** Update the landing page with new LP composability narrative and build the deposit/withdraw flow.

**Requirements:** R13, R14, R15, R17, R18

**Dependencies:** Units 1-3

**Files:**
- Modify: `frontend/src/app/page.tsx` (update narrative, keep cinematic design)
- Create: `frontend/src/app/vault/page.tsx` (deposit/withdraw flow)
- Modify: `frontend/src/components/position-nft-card.tsx` (adapt for LP position data)
- Modify: `frontend/src/lib/demo-constants.ts` (new pool addresses)
- Create: `frontend/src/lib/dlmm-helpers.ts` (SDK wrappers)

**Approach:**
- Landing page: update tagline to "Every position has yield", update demo scenes to show LP composability story
- Vault page: pool selector (hardcoded to demo pool for MVP), range input, deposit amount, "Deposit" button → receive hyLP
- Reuse PositionNftCard to show LP position: token pair, range, fees earned, hyLP balance
- Use `@meteora-ag/dlmm` SDK for pool data and price info

**Patterns to follow:**
- Existing cinematic landing page design (cream/dark, WordsPullUp, motion animations)
- Existing issuer/create page for form patterns

**Test expectation:** none — UI work, no testable backend logic

**Verification:**
- Landing page tells the LP composability story
- User can deposit into DLMM via the vault UI on devnet
- Position card shows live fee data

---

- [ ] **Unit 8: Borrow/repay UI + dashboard**

**Goal:** Build the lending interface and unified dashboard showing the full flywheel.

**Requirements:** R15, R16, R18

**Dependencies:** Units 5, 7

**Files:**
- Create: `frontend/src/app/lend/page.tsx` (borrow/repay flow)
- Modify: `frontend/src/app/vault/page.tsx` (add lending status to dashboard)
- Create: `frontend/src/components/flywheel-viz.tsx` (visual showing the yield stacking)

**Approach:**
- Lend page: show hyLP balance, LTV slider, borrow amount input, "Borrow" button
- Repay flow: show outstanding loan, "Repay" button
- Dashboard: unified view showing LP position value + fees earned + borrowed amount + net position
- Flywheel visualization: animated diagram showing capital flowing through LP → hyLP → collateral → borrow → reinvest

**Patterns to follow:**
- Existing recipient page for grant display patterns
- DeadCapitalComparison component for before/after visuals

**Test expectation:** none — UI work

**Verification:**
- User can borrow against hyLP collateral on devnet
- Dashboard shows accurate positions
- Flywheel visualization communicates the value prop

## System-Wide Impact

- **Interaction graph:** LP Vault CPIs to Meteora DLMM (add_liquidity, remove_liquidity, claim_fee). Lending program CPIs to Transfer Hook (set_user_compliance for collateral lock). Transfer Hook checks collateral status on every hyLP transfer.
- **Error propagation:** DLMM CPI failures surface as vault instruction errors. Lending collateral lock failures prevent borrow/withdraw gracefully.
- **State lifecycle risks:** Partial deposit (tokens sent but position not created) mitigated by atomic CPI. Partial withdrawal (hyLP burned but liquidity not removed) mitigated by checks-effects-interactions.
- **Unchanged invariants:** Transfer Hook's KYC/lockup/holder cap checks remain. Existing frontend pages (issuer, recipient) remain but become secondary.

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DLMM CPI account resolution too complex | Medium | High | Use remaining_accounts passthrough. Fallback: mock DLMM for demo. |
| No DLMM pool liquidity on devnet | Low | Medium | Create own pool + seed with test liquidity |
| Anchor 0.31 vs 0.28 IDL incompatibility | Low | Medium | Use `declare_program!` with raw IDL, not git dependency |
| LP position value fluctuation breaks lending | Medium | Low | Over-collateralize (50% LTV). No auto-liquidation needed for MVP |
| Scope too large for 27 days | Medium | High | Phase 3 (frontend) is parallelizable. Phase 1+2 are the critical path (~10 days). |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-14-lp-composability-requirements.md](docs/brainstorms/2026-04-14-lp-composability-requirements.md)
- Existing vault: `programs/vault/src/lib.rs`
- Existing hook: `programs/transfer-hook/src/lib.rs`
- Meteora CPI: [github.com/MeteoraAg/cpi-examples](https://github.com/MeteoraAg/cpi-examples)
- Meteora SDK: [@meteora-ag/dlmm](https://www.npmjs.com/package/@meteora-ag/dlmm)
- DLMM Program: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
