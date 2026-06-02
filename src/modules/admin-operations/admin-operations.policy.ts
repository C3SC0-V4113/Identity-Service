/**
 * Central risk policy for the machine admin surface (ADR 0008).
 *
 * This is the single source of truth for which operations are high-risk (and
 * therefore approval-gated). Handlers must classify through it instead of
 * hard-coding their own rules, and the resolved `policyVersion` is stored on
 * every `AdminOperation` so an audited action can be tied back to the policy
 * that classified it.
 */
export const ADMIN_POLICY_VERSION = 'risk-policy-2026-06-01';

export type ApprovalLevel = 'none' | 'confirmation';

export interface AdminRiskDecision {
  highRisk: boolean;
  requiredApprovalLevel: ApprovalLevel;
  policyVersion: string;
}

export interface AdminRiskContext {
  operationName: string;
  /** `assignProjectRole`: whether the requested role set grants the admin role. */
  assignsAdminRole?: boolean;
  /** `revokeSession`: whether the revoke targets every session of a user (mass). */
  massSessionRevoke?: boolean;
}

export function classifyOperationRisk(context: AdminRiskContext): AdminRiskDecision {
  const highRisk = isHighRisk(context);

  return {
    highRisk,
    requiredApprovalLevel: highRisk ? 'confirmation' : 'none',
    policyVersion: ADMIN_POLICY_VERSION,
  };
}

function isHighRisk(context: AdminRiskContext): boolean {
  switch (context.operationName) {
    case 'auth.createUser':
    case 'auth.unbanUser':
    case 'auth.revokeProjectAccess':
      return false;
    case 'auth.assignProjectRole':
      return context.assignsAdminRole === true;
    case 'auth.revokeSession':
      return context.massSessionRevoke === true;
    case 'auth.banUser':
    case 'auth.readmitProjectMembership':
      return true;
    default:
      // Default to safe: an unclassified operation must never execute directly.
      return true;
  }
}
