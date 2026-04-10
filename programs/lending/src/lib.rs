use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("J9cqrTyPAajYNUp5ayDQBso7mMAwyatNg7VMpx8wbzwf");

/// Default LTV: 50% (5000 bps)
pub const DEFAULT_LTV_BPS: u16 = 5000;
/// Simple flat interest: 5% APR (500 bps)
pub const DEFAULT_INTEREST_BPS: u16 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod lending {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        ltv_bps: u16,
        interest_bps: u16,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.lending_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.collateral_mint = ctx.accounts.collateral_mint.key();
        pool.borrow_mint = ctx.accounts.borrow_mint.key();
        pool.ltv_bps = ltv_bps;
        pool.interest_bps = interest_bps;
        pool.total_borrowed = 0;
        pool.total_collateral = 0;
        pool.bump = ctx.bumps.lending_pool;
        pool.pool_authority_bump = ctx.bumps.pool_authority;
        Ok(())
    }

    /// Deposit liquidity into the lending pool (lenders provide borrow tokens)
    pub fn deposit_borrow_liquidity(
        ctx: Context<DepositBorrowLiquidity>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.lender_token.to_account_info(),
                    to: ctx.accounts.pool_borrow_token.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                    mint: ctx.accounts.borrow_mint.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.borrow_mint.decimals,
        )?;

        Ok(())
    }

    /// Deposit hyLP collateral and open a loan position
    pub fn deposit_collateral(
        ctx: Context<DepositCollateral>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);

        // Transfer collateral to pool
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_collateral.to_account_info(),
                    to: ctx.accounts.pool_collateral_token.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.collateral_mint.decimals,
        )?;

        let loan = &mut ctx.accounts.loan_position;
        loan.borrower = ctx.accounts.borrower.key();
        loan.collateral_deposited = loan.collateral_deposited
            .checked_add(amount).ok_or(LendingError::MathOverflow)?;
        loan.bump = ctx.bumps.loan_position;

        let pool = &mut ctx.accounts.lending_pool;
        pool.total_collateral = pool.total_collateral
            .checked_add(amount).ok_or(LendingError::MathOverflow)?;

        Ok(())
    }

    /// Borrow tokens against deposited collateral
    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);

        let loan = &ctx.accounts.loan_position;
        let pool = &ctx.accounts.lending_pool;

        // Check LTV: collateral * ltv_bps / 10000 >= borrowed + amount
        let max_borrow = (loan.collateral_deposited as u128)
            .checked_mul(pool.ltv_bps as u128)
            .ok_or(LendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(LendingError::MathOverflow)? as u64;

        let new_total = loan.borrowed_amount
            .checked_add(amount)
            .ok_or(LendingError::MathOverflow)?;

        require!(new_total <= max_borrow, LendingError::ExceedsLtv);

        // Transfer borrow tokens to borrower
        let pool_key = ctx.accounts.lending_pool.key();
        let seeds: &[&[u8]] = &[
            b"pool-authority",
            pool_key.as_ref(),
            &[ctx.accounts.lending_pool.pool_authority_bump],
        ];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_borrow_token.to_account_info(),
                    to: ctx.accounts.borrower_borrow_token.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                    mint: ctx.accounts.borrow_mint.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.borrow_mint.decimals,
        )?;

        // Update state
        let loan = &mut ctx.accounts.loan_position;
        loan.borrowed_amount = new_total;
        if loan.borrow_timestamp == 0 {
            loan.borrow_timestamp = Clock::get()?.unix_timestamp;
        }

        let pool = &mut ctx.accounts.lending_pool;
        pool.total_borrowed = pool.total_borrowed
            .checked_add(amount).ok_or(LendingError::MathOverflow)?;

        Ok(())
    }

    /// Repay borrowed tokens
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);

        let loan = &ctx.accounts.loan_position;
        let repay_amount = amount.min(loan.borrowed_amount);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_borrow_token.to_account_info(),
                    to: ctx.accounts.pool_borrow_token.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                    mint: ctx.accounts.borrow_mint.to_account_info(),
                },
            ),
            repay_amount,
            ctx.accounts.borrow_mint.decimals,
        )?;

        let loan = &mut ctx.accounts.loan_position;
        loan.borrowed_amount = loan.borrowed_amount
            .checked_sub(repay_amount).ok_or(LendingError::MathOverflow)?;

        let pool = &mut ctx.accounts.lending_pool;
        pool.total_borrowed = pool.total_borrowed
            .checked_sub(repay_amount).ok_or(LendingError::MathOverflow)?;

        Ok(())
    }

    /// Withdraw collateral after full repayment
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);

        let loan = &ctx.accounts.loan_position;
        require!(loan.borrowed_amount == 0, LendingError::LoanOutstanding);
        require!(amount <= loan.collateral_deposited, LendingError::InsufficientCollateral);

        let pool_key = ctx.accounts.lending_pool.key();
        let seeds: &[&[u8]] = &[
            b"pool-authority",
            pool_key.as_ref(),
            &[ctx.accounts.lending_pool.pool_authority_bump],
        ];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_collateral_token.to_account_info(),
                    to: ctx.accounts.borrower_collateral.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.collateral_mint.decimals,
        )?;

        let loan = &mut ctx.accounts.loan_position;
        loan.collateral_deposited = loan.collateral_deposited
            .checked_sub(amount).ok_or(LendingError::MathOverflow)?;

        let pool = &mut ctx.accounts.lending_pool;
        pool.total_collateral = pool.total_collateral
            .checked_sub(amount).ok_or(LendingError::MathOverflow)?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct LendingPool {
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub borrow_mint: Pubkey,
    pub ltv_bps: u16,
    pub interest_bps: u16,
    pub total_borrowed: u64,
    pub total_collateral: u64,
    pub bump: u8,
    pub pool_authority_bump: u8,
}

impl LendingPool {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 1 + 1;
}

#[account]
pub struct LoanPosition {
    pub borrower: Pubkey,
    pub collateral_deposited: u64,
    pub borrowed_amount: u64,
    pub borrow_timestamp: i64,
    pub bump: u8,
}

impl LoanPosition {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,
    pub borrow_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = LendingPool::SIZE,
        seeds = [b"lending-pool", collateral_mint.key().as_ref(), borrow_mint.key().as_ref()],
        bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositBorrowLiquidity<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,

    pub borrow_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"lending-pool", lending_pool.collateral_mint.as_ref(), borrow_mint.key().as_ref()],
        bump = lending_pool.bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    /// CHECK: pool authority
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump = lending_pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = borrow_mint, token::authority = lender)]
    pub lender_token: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = borrow_mint, token::authority = pool_authority)]
    pub pool_borrow_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lending-pool", collateral_mint.key().as_ref(), lending_pool.borrow_mint.as_ref()],
        bump = lending_pool.bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    #[account(
        init_if_needed,
        payer = borrower,
        space = LoanPosition::SIZE,
        seeds = [b"loan", lending_pool.key().as_ref(), borrower.key().as_ref()],
        bump,
    )]
    pub loan_position: Account<'info, LoanPosition>,

    /// CHECK: pool authority
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump = lending_pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = collateral_mint, token::authority = borrower)]
    pub borrower_collateral: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = collateral_mint, token::authority = pool_authority)]
    pub pool_collateral_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    pub borrow_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lending-pool", lending_pool.collateral_mint.as_ref(), borrow_mint.key().as_ref()],
        bump = lending_pool.bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan", lending_pool.key().as_ref(), borrower.key().as_ref()],
        bump = loan_position.bump,
        has_one = borrower @ LendingError::Unauthorized,
    )]
    pub loan_position: Account<'info, LoanPosition>,

    /// CHECK: pool authority
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump = lending_pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = borrow_mint, token::authority = pool_authority)]
    pub pool_borrow_token: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = borrow_mint, token::authority = borrower)]
    pub borrower_borrow_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    pub borrow_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lending-pool", lending_pool.collateral_mint.as_ref(), borrow_mint.key().as_ref()],
        bump = lending_pool.bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan", lending_pool.key().as_ref(), borrower.key().as_ref()],
        bump = loan_position.bump,
        has_one = borrower @ LendingError::Unauthorized,
    )]
    pub loan_position: Account<'info, LoanPosition>,

    #[account(mut, token::mint = borrow_mint, token::authority = borrower)]
    pub borrower_borrow_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: pool authority for verification
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump = lending_pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = borrow_mint, token::authority = pool_authority)]
    pub pool_borrow_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"lending-pool", collateral_mint.key().as_ref(), lending_pool.borrow_mint.as_ref()],
        bump = lending_pool.bump,
    )]
    pub lending_pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan", lending_pool.key().as_ref(), borrower.key().as_ref()],
        bump = loan_position.bump,
        has_one = borrower @ LendingError::Unauthorized,
    )]
    pub loan_position: Account<'info, LoanPosition>,

    /// CHECK: pool authority
    #[account(
        seeds = [b"pool-authority", lending_pool.key().as_ref()],
        bump = lending_pool.pool_authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = collateral_mint, token::authority = pool_authority)]
    pub pool_collateral_token: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = collateral_mint, token::authority = borrower)]
    pub borrower_collateral: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum LendingError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Borrow exceeds LTV ratio")]
    ExceedsLtv,
    #[msg("Loan must be fully repaid before withdrawing collateral")]
    LoanOutstanding,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Unauthorized")]
    Unauthorized,
}
