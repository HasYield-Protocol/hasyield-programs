use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked, MintTo, Burn,
};

declare_id!("BH6rAqBajhmzjVPoSqyvuyhCphGVWfKGAD7wXwJU9Y7T");

pub const DEAD_SHARES: u64 = 1_000_000;

/// Meteora DLMM program ID
pub const DLMM_PROGRAM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

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
        config.total_shares = DEAD_SHARES;
        config.deposit_count = 0;
        config.bump = ctx.bumps.vault_config;
        config.vault_authority_bump = ctx.bumps.vault_authority;

        Ok(())
    }

    /// Deposit token X and token Y into the vault.
    /// The vault will hold the tokens and track shares.
    /// (DLMM CPI for add_liquidity is deferred — for MVP the vault holds tokens
    ///  and simulates LP position. Real DLMM CPI added in next iteration.)
    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount_x: u64,
        amount_y: u64,
    ) -> Result<()> {
        require!(amount_x > 0 || amount_y > 0, LpVaultError::ZeroDeposit);

        let config = &ctx.accounts.vault_config;

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

        // Transfer token X to vault
        if amount_x > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.user_token_x.to_account_info(),
                to: ctx.accounts.vault_token_x.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.mint_x.to_account_info(),
            };
            token_interface::transfer_checked(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi),
                amount_x,
                ctx.accounts.mint_x.decimals,
            )?;
        }

        // Transfer token Y to vault
        if amount_y > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.user_token_y.to_account_info(),
                to: ctx.accounts.vault_token_y.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.mint_y.to_account_info(),
            };
            token_interface::transfer_checked(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi),
                amount_y,
                ctx.accounts.mint_y.decimals,
            )?;
        }

        // Mint hyLP tokens to user
        let config_key = ctx.accounts.vault_config.key();
        let seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hylp_mint.to_account_info(),
                    to: ctx.accounts.user_hylp.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
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
    /// Returns proportional share of token X and token Y.
    pub fn withdraw_liquidity(
        ctx: Context<WithdrawLiquidity>,
        shares_to_burn: u64,
    ) -> Result<()> {
        require!(shares_to_burn > 0, LpVaultError::ZeroWithdraw);

        let config = &ctx.accounts.vault_config;
        let total_shares = config.total_shares;

        // Calculate proportional amounts
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

        // Burn hyLP tokens
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.hylp_mint.to_account_info(),
                    from: ctx.accounts.user_hylp.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares_to_burn,
        )?;

        // Transfer tokens back to user
        let config_key = ctx.accounts.vault_config.key();
        let seeds: &[&[u8]] = &[
            b"vault-authority",
            config_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ];
        let signer_seeds = &[seeds];

        if amount_x > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_x.to_account_info(),
                        to: ctx.accounts.user_token_x.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.mint_x.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_x,
                ctx.accounts.mint_x.decimals,
            )?;
        }

        if amount_y > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_y.to_account_info(),
                        to: ctx.accounts.user_token_y.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                        mint: ctx.accounts.mint_y.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_y,
                ctx.accounts.mint_y.decimals,
            )?;
        }

        // Update state
        let config = &mut ctx.accounts.vault_config;
        config.total_deposited_x = config.total_deposited_x
            .checked_sub(amount_x).ok_or(LpVaultError::MathOverflow)?;
        config.total_deposited_y = config.total_deposited_y
            .checked_sub(amount_y).ok_or(LpVaultError::MathOverflow)?;
        config.total_shares = config.total_shares
            .checked_sub(shares_to_burn).ok_or(LpVaultError::MathOverflow)?;

        Ok(())
    }

    /// Simulate fee accrual — increases total_deposited, boosting exchange rate.
    /// In production this would CPI to DLMM claim_fee.
    /// For MVP, authority can call this to simulate yield.
    pub fn simulate_fees(
        ctx: Context<SimulateFees>,
        fee_x: u64,
        fee_y: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_config.authority,
            LpVaultError::Unauthorized
        );

        let config = &mut ctx.accounts.vault_config;
        config.total_deposited_x = config.total_deposited_x
            .checked_add(fee_x).ok_or(LpVaultError::MathOverflow)?;
        config.total_deposited_y = config.total_deposited_y
            .checked_add(fee_y).ok_or(LpVaultError::MathOverflow)?;

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
    pub total_deposited_x: u64,
    pub total_deposited_y: u64,
    pub total_shares: u64,
    pub deposit_count: u64,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

impl LpVaultConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
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

    /// CHECK: vault authority PDA
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

    #[account(mut, mint::authority = vault_authority)]
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

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SimulateFees<'info> {
    pub authority: Signer<'info>,

    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lp-vault-config", mint_x.key().as_ref(), mint_y.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, LpVaultConfig>,
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
}
