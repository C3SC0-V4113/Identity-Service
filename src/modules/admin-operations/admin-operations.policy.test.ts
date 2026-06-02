import { describe, expect, it } from 'vitest';

import { ADMIN_POLICY_VERSION, classifyOperationRisk } from './admin-operations.policy.js';

describe('classifyOperationRisk', () => {
  it('classifies always-direct (low-risk) operations', () => {
    for (const operationName of ['auth.createUser', 'auth.unbanUser', 'auth.revokeProjectAccess']) {
      const decision = classifyOperationRisk({ operationName });
      expect(decision.highRisk).toBe(false);
      expect(decision.requiredApprovalLevel).toBe('none');
      expect(decision.policyVersion).toBe(ADMIN_POLICY_VERSION);
    }
  });

  it('classifies always-high-risk operations', () => {
    for (const operationName of ['auth.banUser', 'auth.readmitProjectMembership']) {
      const decision = classifyOperationRisk({ operationName });
      expect(decision.highRisk).toBe(true);
      expect(decision.requiredApprovalLevel).toBe('confirmation');
    }
  });

  it('treats assignProjectRole as high-risk only when granting the admin role', () => {
    expect(
      classifyOperationRisk({ operationName: 'auth.assignProjectRole', assignsAdminRole: false })
        .highRisk,
    ).toBe(false);
    expect(
      classifyOperationRisk({ operationName: 'auth.assignProjectRole', assignsAdminRole: true })
        .highRisk,
    ).toBe(true);
  });

  it('treats revokeSession as high-risk only for a mass (per-user) revoke', () => {
    expect(
      classifyOperationRisk({ operationName: 'auth.revokeSession', massSessionRevoke: false })
        .highRisk,
    ).toBe(false);
    expect(
      classifyOperationRisk({ operationName: 'auth.revokeSession', massSessionRevoke: true })
        .highRisk,
    ).toBe(true);
  });

  it('defaults to high-risk for an unclassified operation', () => {
    const decision = classifyOperationRisk({ operationName: 'auth.somethingNew' });
    expect(decision.highRisk).toBe(true);
    expect(decision.requiredApprovalLevel).toBe('confirmation');
  });
});
