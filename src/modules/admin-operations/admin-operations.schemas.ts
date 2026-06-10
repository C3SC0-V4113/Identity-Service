// Source of truth: @cesco_valle/identity-contracts (ADR 0002 shared packages).
// This module is a thin re-export so routes/services keep importing from the
// same local path while the schema definitions live in the published package.
export * from '@cesco_valle/identity-contracts/admin';
