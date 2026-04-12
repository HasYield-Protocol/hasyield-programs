#!/bin/bash
# Deploy all programs to Solana devnet
# Usage: ./scripts/deploy.sh

set -e

echo "Building programs..."
anchor build --no-idl

echo "Deploying to devnet..."
anchor deploy --provider.cluster devnet

echo ""
echo "Programs deployed:"
echo "Transfer Hook: $(solana address -k target/deploy/transfer_hook-keypair.json)"
echo "Vault:         $(solana address -k target/deploy/vault-keypair.json)"
echo "Mock Yield:    $(solana address -k target/deploy/mock_yield_source-keypair.json)"

echo ""
echo "Running seed script..."
npx ts-node scripts/seed-demo.ts

echo ""
echo "Deployment complete."
