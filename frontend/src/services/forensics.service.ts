import { ipc } from '@/lib/api'
import type {
  ArtifactEntry,
  AuthAttempt,
  LogChainVerification,
  SearchHit,
  SecretHit,
  SessionEntry,
  SignedForensicManifest,
} from '@/types'

export const forensicsService = {
  sessions: (profileId: string) =>
    ipc.invoke<SessionEntry[]>('forensics_sessions', { profileId }),
  auth: (profileId: string, limit = 300) =>
    ipc.invoke<AuthAttempt[]>('forensics_auth', { profileId, limit }),
  artifacts: (profileId: string, path: string) =>
    ipc.invoke<ArtifactEntry[]>('forensics_artifacts', { profileId, path }),
  search: (profileId: string, path: string, query: string, regex: boolean) =>
    ipc.invoke<SearchHit[]>('forensics_search', { profileId, path, query, regex }),
  secrets: (profileId: string, path: string) =>
    ipc.invoke<SecretHit[]>('forensics_secrets', { profileId, path }),
  verifyChain: () =>
    ipc.invoke<LogChainVerification>('forensics_verify_chain'),
  exportSignedManifest: (profileId: string) =>
    ipc.invoke<SignedForensicManifest>('forensics_export_signed_manifest', { profileId }),
}
