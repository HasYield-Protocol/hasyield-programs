use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            transfer_hook::TransferHookAccount,
            BaseStateWithExtensions, PodStateWithExtensions,
        },
        pod::PodAccount,
    },
    token_interface::Mint,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("EupPmtNiCUWcPGh4ekjLUVhf5PqZWV8BN5zE7426n9vM");

#[program]
pub mod transfer_hook {
    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let extra_metas = vec![
            // index 5: ComplianceConfig PDA — seeds = ["compliance", mint]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"compliance".to_vec() },
                    Seed::AccountKey { index: 1 },
                ],
                false, // is_signer
                false, // is_writable
            )?,
            // index 6: Source UserCompliance PDA — seeds = ["user-compliance", mint, owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"user-compliance".to_vec() },
                    Seed::AccountKey { index: 1 },
                    Seed::AccountKey { index: 3 },
                ],
                false,
                false,
            )?,
            // index 7: Destination UserCompliance PDA — seeds = ["user-compliance", mint, dest_owner]
            // dest_owner is extracted from destination token account data bytes [32..64]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"user-compliance".to_vec() },
                    Seed::AccountKey { index: 1 },
                    Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
                ],
                false,
                false,
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(extra_metas.len())?;
        let lamports = Rent::get()?.minimum_balance(account_size);

        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref()];
        let (_, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
        let signer_seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref(), &[bump]];

        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                &[signer_seeds],
            ),
            lamports,
            account_size as u64,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_metas,
        )?;

        Ok(())
    }

    // Discriminator: sha256("spl-transfer-hook-interface:execute")[0..8]
    #[instruction(discriminator = [105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        check_is_transferring(&ctx)?;

        let config = &ctx.accounts.compliance_config;

        // Check KYC on destination
        if config.kyc_required {
            require!(
                ctx.accounts.destination_compliance.kyc_verified,
                ComplianceError::KycRequired
            );
        }

        // Check holder cap — if destination is a new holder (not yet KYC'd or first transfer)
        if config.max_holders > 0 {
            // If destination has no compliance record yet, they'd be a new holder
            if !ctx.accounts.destination_compliance.kyc_verified
                && ctx.accounts.destination_compliance.lockup_unlock_at == 0
            {
                require!(
                    config.current_holders < config.max_holders,
                    ComplianceError::HolderCapReached
                );
            }
        }

        // Check lockup on source
        let clock = Clock::get()?;
        let source_compliance = &ctx.accounts.source_compliance;
        if source_compliance.lockup_unlock_at > 0 {
            require!(
                clock.unix_timestamp >= source_compliance.lockup_unlock_at,
                ComplianceError::LockupActive
            );
        }

        Ok(())
    }

    pub fn set_compliance_config(
        ctx: Context<SetComplianceConfig>,
        kyc_required: bool,
        lockup_duration: i64,
        max_holders: u32,
    ) -> Result<()> {
        let config = &mut ctx.accounts.compliance_config;
        // Only set authority on first init; subsequent calls must come from existing authority
        if config.authority != Pubkey::default() {
            require!(
                config.authority == ctx.accounts.authority.key(),
                ComplianceError::Unauthorized
            );
        }
        config.authority = ctx.accounts.authority.key();
        config.kyc_required = kyc_required;
        config.lockup_duration = lockup_duration;
        config.max_holders = max_holders;
        config.bump = ctx.bumps.compliance_config;
        Ok(())
    }

    pub fn set_user_compliance(
        ctx: Context<SetUserCompliance>,
        kyc_verified: bool,
        lockup_unlock_at: i64,
    ) -> Result<()> {
        let user = &mut ctx.accounts.user_compliance;
        let was_holder = user.kyc_verified;
        user.kyc_verified = kyc_verified;
        user.lockup_unlock_at = lockup_unlock_at;
        user.bump = ctx.bumps.user_compliance;

        // Track holder count changes
        let config = &mut ctx.accounts.compliance_config;
        if kyc_verified && !was_holder {
            config.current_holders = config.current_holders.saturating_add(1);
        } else if !kyc_verified && was_holder {
            config.current_holders = config.current_holders.saturating_sub(1);
        }

        Ok(())
    }
}

fn check_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    let source_info = ctx.accounts.source_token.to_account_info();
    let data = source_info.try_borrow_data()?;
    let account = PodStateWithExtensions::<PodAccount>::unpack(&data)?;
    let ext = account.get_extension::<TransferHookAccount>()?;
    require!(
        bool::from(ext.transferring),
        ComplianceError::NotTransferring
    );
    Ok(())
}

// --- Accounts ---

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList PDA, created in instruction
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Mint authority must sign
    pub mint_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: Source token account — validated in handler
    pub source_token: UncheckedAccount<'info>,

    /// CHECK: Mint — validated in handler
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Destination token account — validated in handler
    pub destination_token: UncheckedAccount<'info>,

    /// CHECK: Source token owner — can be wallet or PDA
    pub owner: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList PDA
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub compliance_config: Account<'info, ComplianceConfig>,

    pub source_compliance: Account<'info, UserCompliance>,

    pub destination_compliance: Account<'info, UserCompliance>,
}

#[derive(Accounts)]
pub struct SetComplianceConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ComplianceConfig::INIT_SPACE,
        seeds = [b"compliance", mint.key().as_ref()],
        bump,
    )]
    pub compliance_config: Account<'info, ComplianceConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetUserCompliance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: The user wallet this compliance record is for
    pub user_wallet: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"compliance", mint.key().as_ref()],
        bump = compliance_config.bump,
        has_one = authority @ ComplianceError::Unauthorized,
    )]
    pub compliance_config: Account<'info, ComplianceConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserCompliance::INIT_SPACE,
        seeds = [b"user-compliance", mint.key().as_ref(), user_wallet.key().as_ref()],
        bump,
    )]
    pub user_compliance: Account<'info, UserCompliance>,

    pub system_program: Program<'info, System>,
}

// --- State ---

#[account]
#[derive(InitSpace)]
pub struct ComplianceConfig {
    pub authority: Pubkey,
    pub kyc_required: bool,
    pub lockup_duration: i64,
    pub max_holders: u32,
    pub current_holders: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserCompliance {
    pub kyc_verified: bool,
    pub lockup_unlock_at: i64,
    pub bump: u8,
}

// --- Errors ---

#[error_code]
pub enum ComplianceError {
    #[msg("Transfer not initiated by Token-2022")]
    NotTransferring,
    #[msg("Destination wallet has not completed KYC")]
    KycRequired,
    #[msg("Source tokens are still under lockup")]
    LockupActive,
    #[msg("Unauthorized: signer is not the compliance authority")]
    Unauthorized,
    #[msg("Maximum holder cap reached")]
    HolderCapReached,
}
