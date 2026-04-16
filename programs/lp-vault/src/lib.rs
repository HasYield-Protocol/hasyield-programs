use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked, MintTo, Burn,
};

declare_id!("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");

pub const DEAD_SHARES: u64 = 1_000_000;

/// Meteora DLMM program ID
pub const DLMM_PROGRAM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Max bins per array in DLMM
pub const MAX_BIN_PER_ARRAY: i32 = 70;

// DLMM instruction discriminators (from IDL)
pub const IX_INITIALIZE_POSITION: [u8; 8] = [219, 192, 234, 71, 190, 191, 102, 80];
pub const IX_ADD_LIQUIDITY_BY_STRATEGY: [u8; 8] = [7, 3, 150, 127, 148, 40, 61, 200];
pub const IX_ADD_LIQUIDITY_BY_STRATEGY_ONE_SIDE: [u8; 8] = [41, 5, 238, 175, 100, 225, 6, 205];
pub const IX_REMOVE_LIQUIDITY_BY_RANGE: [u8; 8] = [26, 82, 102, 152, 240, 74, 105, 26];
pub const IX_CLAIM_FEE: [u8; 8] = [169, 32, 79, 137, 136, 232, 70, 137];

/// Marinade Finance program ID
pub const MARINADE_PROGRAM: Pubkey = pubkey!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");

// Marinade instruction discriminators (Anchor sha256("global:<name>")[..8])
pub const IX_MARINADE_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
pub const IX_MARINADE_LIQUID_UNSTAKE: [u8; 8] = [30, 30, 119, 240, 191, 227, 12, 16];

/// Solend program ID (devnet)
pub const SOLEND_PROGRAM: Pubkey = pubkey!("ALend7Ketfx5bxh6ghsCDXAoDrhvEmsXT3cynB6aPLgx");

// Solend instruction tags (SPL Token Lending format: 1 byte tag + args)
pub const IX_SOLEND_DEPOSIT: u8 = 4;  // DepositReserveLiquidity
pub const IX_SOLEND_REDEEM: u8 = 5;   // RedeemReserveCollateral

#[program]
pub mod lp_vault {
    use super::*;

    /// Initialize an LP vault for a specific DLMM pool.
    /// Creates the vault config, vault authority PDA, and hyLP mint.
    pub fn initialize_lp_vault(
        ctx: Context<InitializeLpVault>,
        lb_pair: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.vault_config;
        config.authority = ctx.accounts.authority.key();
        config.lb_pair = lb_pair;
        config.hylp_mint = ctx.accounts.hylp_mint.key();
        config.total_deposited_x = 0;
        config.total_deposited_y = 0;
        config.position = Pubkey::default();
        config.total_shares = DEAD_SHARES;
        config.deposit_count = 0;
        config.lower_bin_id = 0;
        config.width = 0;
        config.position_initialized = false;
        config.bump = ctx.bumps.vault_config;
        config.vault_authority_bump = ctx.bumps.vault_authority;
        config._reserved = [0u8; 64];

        Ok(())
    }

    /// Deposit token X and token Y into the vault.
    /// Transfers tokens from user → vault, then CPI to DLMM add_liquidity_by_strategy.
    /// Mints hyLP Token-2022 shares proportional to deposit.
    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount_x: u64,
        amount_y: u64,
        active_id: i32,
        max_active_bin_slippage: i32,
    ) -> Result<()> {
        require!(amount_x > 0 || amount_y > 0, LpVaultError::ZeroDeposit);

        let config = &ctx.accounts.vault_config;
        require!(config.position_initialized, LpVaultError::PositionNotInitialized);

        // Calculate shares based on total value deposited
        let total_value = config.total_deposited_x.saturating_add(config.total_deposited_y);
        let deposit_value = amount_x.saturating_add(amount_y);
        let shares = if total_value == 0 {
            deposit_value.checked_sub(DEAD_SHARES).ok_or(LpVaultError::DepositTooSmall)?
        } else {
            (deposit_value as u128)
                .checked_mul(config.total_shares as u128)
                .ok_or(LpVaultError::MathOverflow)?
                .checked_div(total_value as u128)
                .ok_or(LpVaultError::MathOverflow)? as u64
        };
        require!(shares > 0, LpVaultError::DepositTooSmall);

        // Transfer token X from user to vault
        if amount_x > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.user_token_x.to_account_info(),
                        to: ctx.accounts.vault_token_x.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                        mint: ctx.accounts.mint_x.to_account_info(),
                    },
                ),
                amount_x,
                ctx.accounts.mint_x.decimals,
            )?;
        }

        // Transfer token Y from user to vault
        if amount_y > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.user_token_y.to_account_info(),
                        to: ctx.accounts.vault_token_y.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                        mint: ctx.accounts.mint_y.to_account_info(),
                    },
                ),
                amount_y,
                ctx.accounts.mint_y.decimals,
            )?;
        }

        // CPI to DLMM: add_liquidity_by_strategy
        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        let lower = ctx.accounts.vault_config.lower_bin_id;
        let width = ctx.accounts.vault_config.width;

        // DLMM add_liquidity_by_strategy (always use two-sided instruction)
        // Strategy: SpotImBalanced (variant 6) with parameteres[0] = favorSide
        //   favorSide: 0 = Y-favored (single Y deposit), 1 = X-favored, ignored when both > 0
        // This matches the Meteora SDK's toStrategyParameters behavior.
        let mut parameteres = [0u8; 64];
        let strategy_type: u8 = if amount_x > 0 && amount_y > 0 {
            3 // SpotBalanced
        } else {
            // SpotImBalanced with favorSide flag
            if amount_x > 0 {
                parameteres[0] = 1; // favor X side
            }
            // else parameteres[0] stays 0 = favor Y side
            6 // SpotImBalanced
        };

        let mut ix_data = Vec::with_capacity(8 + 8 + 8 + 4 + 4 + 4 + 4 + 1 + 64);
        ix_data.extend_from_slice(&IX_ADD_LIQUIDITY_BY_STRATEGY);
        ix_data.extend_from_slice(&amount_x.to_le_bytes());
        ix_data.extend_from_slice(&amount_y.to_le_bytes());
        ix_data.extend_from_slice(&active_id.to_le_bytes());
        ix_data.extend_from_slice(&max_active_bin_slippage.to_le_bytes());
        // StrategyParameters
        ix_data.extend_from_slice(&lower.to_le_bytes());                // min_bin_id
        ix_data.extend_from_slice(&(lower + width - 1).to_le_bytes()); // max_bin_id
        ix_data.push(strategy_type);
        ix_data.extend_from_slice(&parameteres);

        let ix = Instruction {
            program_id: DLMM_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_bitmap_extension.key(), false),
                AccountMeta::new(ctx.accounts.vault_token_x.key(), false),
                AccountMeta::new(ctx.accounts.vault_token_y.key(), false),
                AccountMeta::new(ctx.accounts.reserve_x.key(), false),
                AccountMeta::new(ctx.accounts.reserve_y.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_x.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_y.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_lower.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_upper.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(DLMM_PROGRAM, false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_extension.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.mint_x.to_account_info(),
                ctx.accounts.mint_y.to_account_info(),
                ctx.accounts.bin_array_lower.to_account_info(),
                ctx.accounts.bin_array_upper.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        // Mint hyLP tokens to user
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hylp_mint.to_account_info(),
                    to: ctx.accounts.user_hylp.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_auth_seeds],
            ),
            shares,
        )?;

        // Update vault state
        let config = &mut ctx.accounts.vault_config;
        config.total_deposited_x = config.total_deposited_x
            .checked_add(amount_x).ok_or(LpVaultError::MathOverflow)?;
        config.total_deposited_y = config.total_deposited_y
            .checked_add(amount_y).ok_or(LpVaultError::MathOverflow)?;
        config.total_shares = config.total_shares
            .checked_add(shares).ok_or(LpVaultError::MathOverflow)?;
        config.deposit_count = config.deposit_count
            .checked_add(1).ok_or(LpVaultError::MathOverflow)?;

        Ok(())
    }

    /// Withdraw liquidity by burning hyLP tokens.
    /// CPI to DLMM remove_liquidity_by_range, then transfer tokens to user.
    pub fn withdraw_liquidity(
        ctx: Context<WithdrawLiquidity>,
        shares_to_burn: u64,
    ) -> Result<()> {
        require!(shares_to_burn > 0, LpVaultError::ZeroWithdraw);

        let config = &ctx.accounts.vault_config;
        require!(config.position_initialized, LpVaultError::PositionNotInitialized);
        let total_shares = config.total_shares;

        // Calculate proportional amounts for state tracking
        let amount_x = (shares_to_burn as u128)
            .checked_mul(config.total_deposited_x as u128)
            .ok_or(LpVaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(LpVaultError::MathOverflow)? as u64;
        let amount_y = (shares_to_burn as u128)
            .checked_mul(config.total_deposited_y as u128)
            .ok_or(LpVaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(LpVaultError::MathOverflow)? as u64;

        // Calculate bps_to_remove: proportional to shares being burned
        let bps_to_remove = ((shares_to_burn as u128)
            .checked_mul(10_000u128)
            .ok_or(LpVaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(LpVaultError::MathOverflow)?) as u16;

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        let lower = ctx.accounts.vault_config.lower_bin_id;
        let width = ctx.accounts.vault_config.width;

        // CPI to DLMM: remove_liquidity_by_range
        let mut ix_data = Vec::with_capacity(8 + 4 + 4 + 2);
        ix_data.extend_from_slice(&IX_REMOVE_LIQUIDITY_BY_RANGE);
        ix_data.extend_from_slice(&lower.to_le_bytes());              // from_bin_id
        ix_data.extend_from_slice(&(lower + width - 1).to_le_bytes()); // to_bin_id
        ix_data.extend_from_slice(&bps_to_remove.to_le_bytes());

        let ix = Instruction {
            program_id: DLMM_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_bitmap_extension.key(), false),
                AccountMeta::new(ctx.accounts.vault_token_x.key(), false),  // user_token_x
                AccountMeta::new(ctx.accounts.vault_token_y.key(), false),  // user_token_y
                AccountMeta::new(ctx.accounts.reserve_x.key(), false),
                AccountMeta::new(ctx.accounts.reserve_y.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_x.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_y.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_lower.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_upper.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true), // sender
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(DLMM_PROGRAM, false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_extension.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.mint_x.to_account_info(),
                ctx.accounts.mint_y.to_account_info(),
                ctx.accounts.bin_array_lower.to_account_info(),
                ctx.accounts.bin_array_upper.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        // Reload vault token balances after DLMM removal to get actual returned amounts
        ctx.accounts.vault_token_x.reload()?;
        ctx.accounts.vault_token_y.reload()?;
        let actual_x = ctx.accounts.vault_token_x.amount;
        let actual_y = ctx.accounts.vault_token_y.amount;

        // Use the lesser of calculated vs actual (handles DLMM rounding)
        let transfer_x = amount_x.min(actual_x);
        let transfer_y = amount_y.min(actual_y);

        // Burn hyLP tokens
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program_2022.to_account_info(),
                Burn {
                    mint: ctx.accounts.hylp_mint.to_account_info(),
                    from: ctx.accounts.user_hylp.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares_to_burn,
        )?;

        // Transfer tokens from vault to user
        if transfer_x > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_x.to_account_info(),
                        to: ctx.accounts.user_token_x.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.mint_x.to_account_info(),
                    },
                    &[vault_auth_seeds],
                ),
                transfer_x,
                ctx.accounts.mint_x.decimals,
            )?;
        }

        if transfer_y > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_y.to_account_info(),
                        to: ctx.accounts.user_token_y.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.mint_y.to_account_info(),
                    },
                    &[vault_auth_seeds],
                ),
                transfer_y,
                ctx.accounts.mint_y.decimals,
            )?;
        }

        // Update state with actual amounts transferred
        let config = &mut ctx.accounts.vault_config;
        config.total_deposited_x = config.total_deposited_x
            .checked_sub(transfer_x).ok_or(LpVaultError::MathOverflow)?;
        config.total_deposited_y = config.total_deposited_y
            .checked_sub(transfer_y).ok_or(LpVaultError::MathOverflow)?;
        config.total_shares = config.total_shares
            .checked_sub(shares_to_burn).ok_or(LpVaultError::MathOverflow)?;

        Ok(())
    }

    /// Close a vault config account (admin-only, for migration/cleanup).
    /// Uses raw account to handle old state layouts that can't deserialize.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        // Verify authority: first 32 bytes after 8-byte discriminator = authority pubkey
        let data = ctx.accounts.vault_config.data.borrow();
        require!(data.len() >= 40, LpVaultError::Unauthorized);
        let stored_authority = Pubkey::try_from(&data[8..40])
            .map_err(|_| LpVaultError::Unauthorized)?;
        require!(
            ctx.accounts.authority.key() == stored_authority,
            LpVaultError::Unauthorized
        );
        drop(data);

        // Transfer lamports to authority and zero the account
        let vault_lamports = ctx.accounts.vault_config.lamports();
        **ctx.accounts.vault_config.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.authority.try_borrow_mut_lamports()? = ctx.accounts.authority
            .lamports()
            .checked_add(vault_lamports)
            .ok_or(LpVaultError::MathOverflow)?;

        // Zero the data to mark as closed
        let mut data = ctx.accounts.vault_config.data.borrow_mut();
        data.fill(0);

        Ok(())
    }

    /// Initialize a DLMM position for the vault (admin, one-time).
    /// Creates a position on Meteora DLMM owned by the vault authority PDA.
    pub fn initialize_position(
        ctx: Context<InitializePosition>,
        lower_bin_id: i32,
        width: i32,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );
        require!(!ctx.accounts.vault_config.position_initialized, LpVaultError::PositionAlreadyInitialized);
        require!(width > 0 && width <= MAX_BIN_PER_ARRAY, LpVaultError::InvalidWidth);

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        // Build DLMM initialize_position instruction
        let mut ix_data = Vec::with_capacity(16);
        ix_data.extend_from_slice(&IX_INITIALIZE_POSITION);
        ix_data.extend_from_slice(&lower_bin_id.to_le_bytes());
        ix_data.extend_from_slice(&width.to_le_bytes());

        let ix = Instruction {
            program_id: DLMM_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.authority.key(), true),           // payer
                AccountMeta::new(ctx.accounts.position.key(), true),            // position (signer)
                AccountMeta::new_readonly(ctx.accounts.lb_pair.key(), false),   // lb_pair
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true), // owner (PDA signer)
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(DLMM_PROGRAM, false),                // program self-reference
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        let config = &mut ctx.accounts.vault_config;
        config.position = ctx.accounts.position.key();
        config.lower_bin_id = lower_bin_id;
        config.width = width;
        config.position_initialized = true;

        Ok(())
    }

    /// Claim trading fees from the DLMM position.
    /// Replaces simulate_fees — this harvests real yield.
    pub fn claim_fees(
        ctx: Context<ClaimFees>,
    ) -> Result<()> {
        let config = &ctx.accounts.vault_config;
        require!(config.position_initialized, LpVaultError::PositionNotInitialized);

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[config.vault_authority_bump],
        ];

        // Record balances before claim
        let balance_x_before = ctx.accounts.vault_token_x.amount;
        let balance_y_before = ctx.accounts.vault_token_y.amount;

        let ix = Instruction {
            program_id: DLMM_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_lower.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_upper.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true), // sender
                AccountMeta::new(ctx.accounts.reserve_x.key(), false),
                AccountMeta::new(ctx.accounts.reserve_y.key(), false),
                AccountMeta::new(ctx.accounts.vault_token_x.key(), false),
                AccountMeta::new(ctx.accounts.vault_token_y.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_x_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_y_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(DLMM_PROGRAM, false),
            ],
            data: IX_CLAIM_FEE.to_vec(),
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.bin_array_lower.to_account_info(),
                ctx.accounts.bin_array_upper.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        // Reload balances and update deposited amounts with fees earned
        ctx.accounts.vault_token_x.reload()?;
        ctx.accounts.vault_token_y.reload()?;

        let fee_x = ctx.accounts.vault_token_x.amount.saturating_sub(balance_x_before);
        let fee_y = ctx.accounts.vault_token_y.amount.saturating_sub(balance_y_before);

        let config = &mut ctx.accounts.vault_config;
        config.total_deposited_x = config.total_deposited_x
            .checked_add(fee_x).ok_or(LpVaultError::MathOverflow)?;
        config.total_deposited_y = config.total_deposited_y
            .checked_add(fee_y).ok_or(LpVaultError::MathOverflow)?;

        Ok(())
    }

    /// Deposit idle SOL from vault to Marinade Finance for staking yield.
    /// Vault PDA transfers SOL → Marinade, receives mSOL.
    pub fn deposit_to_marinade(
        ctx: Context<DepositToMarinade>,
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, LpVaultError::ZeroAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        // Build Marinade deposit instruction
        let mut ix_data = Vec::with_capacity(16);
        ix_data.extend_from_slice(&IX_MARINADE_DEPOSIT);
        ix_data.extend_from_slice(&lamports.to_le_bytes());

        let ix = Instruction {
            program_id: MARINADE_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.marinade_state.key(), false),
                AccountMeta::new(ctx.accounts.msol_mint.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_sol_leg_pda.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
                AccountMeta::new_readonly(ctx.accounts.liq_pool_msol_leg_authority.key(), false),
                AccountMeta::new(ctx.accounts.reserve_pda.key(), false),
                AccountMeta::new(ctx.accounts.vault_authority.key(), true), // transfer_from (PDA signer)
                AccountMeta::new(ctx.accounts.vault_msol_ata.key(), false), // mint_to
                AccountMeta::new_readonly(ctx.accounts.msol_mint_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.marinade_state.to_account_info(),
                ctx.accounts.msol_mint.to_account_info(),
                ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                ctx.accounts.liq_pool_msol_leg.to_account_info(),
                ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
                ctx.accounts.reserve_pda.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.vault_msol_ata.to_account_info(),
                ctx.accounts.msol_mint_authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.marinade_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        Ok(())
    }

    /// Withdraw SOL from Marinade (liquid unstake mSOL → SOL).
    pub fn withdraw_from_marinade(
        ctx: Context<WithdrawFromMarinade>,
        msol_amount: u64,
    ) -> Result<()> {
        require!(msol_amount > 0, LpVaultError::ZeroAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        let mut ix_data = Vec::with_capacity(16);
        ix_data.extend_from_slice(&IX_MARINADE_LIQUID_UNSTAKE);
        ix_data.extend_from_slice(&msol_amount.to_le_bytes());

        let ix = Instruction {
            program_id: MARINADE_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.marinade_state.key(), false),
                AccountMeta::new(ctx.accounts.msol_mint.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_sol_leg_pda.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
                AccountMeta::new(ctx.accounts.treasury_msol_account.key(), false),
                AccountMeta::new(ctx.accounts.vault_msol_ata.key(), false), // get_msol_from
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true), // get_msol_from_authority (PDA signer)
                AccountMeta::new(ctx.accounts.vault_authority.key(), false), // transfer_sol_to
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.marinade_state.to_account_info(),
                ctx.accounts.msol_mint.to_account_info(),
                ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                ctx.accounts.liq_pool_msol_leg.to_account_info(),
                ctx.accounts.treasury_msol_account.to_account_info(),
                ctx.accounts.vault_msol_ata.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.marinade_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        Ok(())
    }

    /// Deposit tokens into Solend lending reserve for yield.
    /// Vault PDA deposits liquidity → receives cTokens.
    pub fn deposit_to_solend(
        ctx: Context<DepositToSolend>,
        liquidity_amount: u64,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        // Solend DepositReserveLiquidity: tag 4 + u64 LE amount
        let mut ix_data = Vec::with_capacity(9);
        ix_data.push(IX_SOLEND_DEPOSIT);
        ix_data.extend_from_slice(&liquidity_amount.to_le_bytes());

        let ix = Instruction {
            program_id: SOLEND_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.source_liquidity.key(), false),
                AccountMeta::new(ctx.accounts.destination_collateral.key(), false),
                AccountMeta::new(ctx.accounts.reserve.key(), false),
                AccountMeta::new(ctx.accounts.reserve_liquidity_supply.key(), false),
                AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
                AccountMeta::new_readonly(ctx.accounts.lending_market_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true), // user_transfer_authority
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.source_liquidity.to_account_info(),
                ctx.accounts.destination_collateral.to_account_info(),
                ctx.accounts.reserve.to_account_info(),
                ctx.accounts.reserve_liquidity_supply.to_account_info(),
                ctx.accounts.reserve_collateral_mint.to_account_info(),
                ctx.accounts.lending_market.to_account_info(),
                ctx.accounts.lending_market_authority.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.solend_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        Ok(())
    }

    /// Withdraw tokens from Solend (redeem cTokens → liquidity).
    pub fn withdraw_from_solend(
        ctx: Context<WithdrawFromSolend>,
        collateral_amount: u64,
    ) -> Result<()> {
        require!(collateral_amount > 0, LpVaultError::ZeroAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );

        let config_key = ctx.accounts.vault_config.key();
        let vault_auth_seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];

        // Solend RedeemReserveCollateral: tag 5 + u64 LE amount
        let mut ix_data = Vec::with_capacity(9);
        ix_data.push(IX_SOLEND_REDEEM);
        ix_data.extend_from_slice(&collateral_amount.to_le_bytes());

        let ix = Instruction {
            program_id: SOLEND_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.source_collateral.key(), false),
                AccountMeta::new(ctx.accounts.destination_liquidity.key(), false),
                AccountMeta::new(ctx.accounts.reserve.key(), false),
                AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
                AccountMeta::new(ctx.accounts.reserve_liquidity_supply.key(), false),
                AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
                AccountMeta::new_readonly(ctx.accounts.lending_market_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: ix_data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.source_collateral.to_account_info(),
                ctx.accounts.destination_liquidity.to_account_info(),
                ctx.accounts.reserve.to_account_info(),
                ctx.accounts.reserve_collateral_mint.to_account_info(),
                ctx.accounts.reserve_liquidity_supply.to_account_info(),
                ctx.accounts.lending_market.to_account_info(),
                ctx.accounts.lending_market_authority.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.solend_program.to_account_info(),
            ],
            &[vault_auth_seeds],
        )?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct LpVaultConfig {
    pub authority: Pubkey,
    pub lb_pair: Pubkey,
    pub hylp_mint: Pubkey,
    pub position: Pubkey,
    pub total_deposited_x: u64,
    pub total_deposited_y: u64,
    pub total_shares: u64,
    pub deposit_count: u64,
    pub lower_bin_id: i32,
    pub width: i32,
    pub position_initialized: bool,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub _reserved: [u8; 64],
}

impl LpVaultConfig {
    // 8 discriminator + 32*4 + 8*4 + 4*2 + 1 + 1 + 1 + 64 = 243
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 4 + 4 + 1 + 1 + 1 + 64;
}

/// Placeholder for vault authority PDA (just holds bump)
#[account]
pub struct VaultAuthority {
    pub bump: u8,
}

impl VaultAuthority {
    pub const SIZE: usize = 8 + 1;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeLpVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = LpVaultConfig::SIZE,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: PDA authority for vault operations
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// hyLP mint — Token-2022, authority = vault_authority PDA
    #[account(
        mut,
        mint::authority = vault_authority,
        mint::token_program = token_program,
    )]
    pub hylp_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA — signs as DLMM sender
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub hylp_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_hylp: InterfaceAccount<'info, TokenAccount>,

    // --- DLMM accounts ---

    /// CHECK: DLMM position account
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: DLMM lb_pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array bitmap extension (optional but must be passed)
    #[account(mut)]
    pub bin_array_bitmap_extension: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve X token account
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve Y token account
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array lower
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array upper
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: DLMM event authority PDA
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: DLMM program
    #[account(address = DLMM_PROGRAM)]
    pub dlmm_program: UncheckedAccount<'info>,

    /// SPL Token program for USDC/SOL transfers
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 program for hyLP mint/burn
    pub token_program_2022: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub hylp_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = mint_x, token::authority = user)]
    pub user_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_y, token::authority = user)]
    pub user_token_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_x, token::authority = vault_authority)]
    pub vault_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_y, token::authority = vault_authority)]
    pub vault_token_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = hylp_mint, token::authority = user)]
    pub user_hylp: InterfaceAccount<'info, TokenAccount>,

    // --- DLMM accounts ---

    /// CHECK: DLMM position account
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: DLMM lb_pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array bitmap extension
    #[account(mut)]
    pub bin_array_bitmap_extension: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve X
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve Y
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array lower
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array upper
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: DLMM event authority PDA
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: DLMM program
    #[account(address = DLMM_PROGRAM)]
    pub dlmm_program: UncheckedAccount<'info>,

    /// SPL Token program for SOL/USDC transfers
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 program for hyLP burn
    pub token_program_2022: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: raw account — may have old layout that can't deserialize
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializePosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA — signs as DLMM position owner
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: new DLMM position account (keypair signer, created by DLMM program)
    #[account(mut, signer)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: DLMM lb_pair account
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: DLMM event authority PDA
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: DLMM program
    #[account(address = DLMM_PROGRAM)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub authority: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: DLMM position account
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: DLMM lb_pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array lower
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: DLMM bin array upper
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve X
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,

    /// CHECK: DLMM reserve Y
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_y: InterfaceAccount<'info, TokenAccount>,

    pub token_x_mint: InterfaceAccount<'info, Mint>,
    pub token_y_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: DLMM event authority PDA
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: DLMM program
    #[account(address = DLMM_PROGRAM)]
    pub dlmm_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositToMarinade<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA — signs as SOL depositor into Marinade
    #[account(
        mut,
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Marinade state account
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,

    /// CHECK: mSOL mint
    #[account(mut)]
    pub msol_mint: UncheckedAccount<'info>,

    /// CHECK: Marinade liq pool SOL leg PDA
    #[account(mut)]
    pub liq_pool_sol_leg_pda: UncheckedAccount<'info>,

    /// CHECK: Marinade liq pool mSOL leg token account
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,

    /// CHECK: Marinade liq pool mSOL leg authority PDA
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,

    /// CHECK: Marinade reserve PDA
    #[account(mut)]
    pub reserve_pda: UncheckedAccount<'info>,

    /// Vault's mSOL token account (receives mSOL)
    #[account(mut)]
    pub vault_msol_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: mSOL mint authority PDA
    pub msol_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Marinade program
    #[account(address = MARINADE_PROGRAM)]
    pub marinade_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawFromMarinade<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"lp-vault-config", vault_config.lb_pair.as_ref(), vault_config.hylp_mint.as_ref()],
        bump = vault_config.bump,
        constraint = false @ LpVaultError::Unauthorized,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA
    #[account(
        mut,
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Marinade state account
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,

    /// CHECK: mSOL mint
    #[account(mut)]
    pub msol_mint: UncheckedAccount<'info>,

    /// CHECK: Marinade liq pool SOL leg PDA
    #[account(mut)]
    pub liq_pool_sol_leg_pda: UncheckedAccount<'info>,

    /// CHECK: Marinade liq pool mSOL leg token account
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,

    /// CHECK: Marinade treasury mSOL account
    #[account(mut)]
    pub treasury_msol_account: UncheckedAccount<'info>,

    /// Vault's mSOL token account (burns mSOL from here)
    #[account(mut)]
    pub vault_msol_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Marinade program
    #[account(address = MARINADE_PROGRAM)]
    pub marinade_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DepositToSolend<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA — signs as transfer authority
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Vault's liquidity token account (source — e.g. USDC)
    #[account(mut)]
    pub source_liquidity: InterfaceAccount<'info, TokenAccount>,

    /// Vault's cToken account (destination — receives cTokens)
    #[account(mut)]
    pub destination_collateral: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Solend reserve account
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Reserve liquidity supply vault
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: Reserve collateral mint (cToken mint)
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    /// CHECK: Solend lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Lending market authority PDA
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: Solend program
    #[account(address = SOLEND_PROGRAM)]
    pub solend_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawFromSolend<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub vault_config: Account<'info, LpVaultConfig>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [b"vault-authority", vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Vault's cToken account (source — burn cTokens)
    #[account(mut)]
    pub source_collateral: InterfaceAccount<'info, TokenAccount>,

    /// Vault's liquidity token account (destination — receive tokens back)
    #[account(mut)]
    pub destination_liquidity: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Solend reserve account
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Reserve collateral mint
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    /// CHECK: Reserve liquidity supply vault
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: Solend lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Lending market authority PDA
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: Solend program
    #[account(address = SOLEND_PROGRAM)]
    pub solend_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum LpVaultError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("Deposit too small to mint shares")]
    DepositTooSmall,
    #[msg("Withdraw amount must be greater than zero")]
    ZeroWithdraw,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("DLMM position already initialized")]
    PositionAlreadyInitialized,
    #[msg("DLMM position not initialized")]
    PositionNotInitialized,
    #[msg("Invalid position width")]
    InvalidWidth,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
