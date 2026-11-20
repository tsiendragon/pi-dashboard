// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * Pi Matrix dashboard plugin.
 *
 * Read-only view of pi-matrix proof projects. Mathematical status is always the
 * Python kernel's (`pimatrix status`), never derived in the browser.
 */
export {
  ProofStatusRenderer,
  ProofClaimRenderer,
  ProofSubmitRenderer,
  ProofProveRenderer,
  ProofReviewRenderer,
  ProofCertifyRenderer,
  ProofAuditRenderer,
  ProofSolveRenderer,
  ProofSolveStatusRenderer,
  ProofLeanRenderer,
  ProofSearchRenderer,
  ProofCiteRenderer,
  ProofCiteCheckRenderer,
  ProofAttemptRenderer,
  ProofGenericRenderer,
} from './cards'

export { PimatrixStatusMessage, PimatrixCheckMessage } from './messages'
export { ProofStatusBar, ProofSidebarPanel, ProofSettings } from './panels'
export { ProofOverviewPage } from './overview'
