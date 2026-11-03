import type { DbTarget, ShareConnectionPreview, ShareProfileSummary } from '@/types'

interface ShareSummaryProps {
  profile: Pick<
    ShareProfileSummary,
    'name' | 'host' | 'port' | 'username' | 'authMethod' | 'environment'
  >
  database?: DbTarget | null
  hostKey?: { fingerprint: string; algorithm?: string | null } | null
  preview?: ShareConnectionPreview
}

export function ShareSummary({
  profile,
  database,
  hostKey,
  preview,
}: ShareSummaryProps) {
  const hasSshSecrets = Boolean(
    preview && (preview.hasSshPassword || preview.hasPrivateKey || preview.hasPassphrase),
  )

  return (
    <div className="share-summary" data-testid="share-summary">
      <div className="share-summary__header">
        <div className="share-summary__title">
          <strong>{profile.name}</strong>
          <span className={`env-chip env-${profile.environment}`}>
            {profile.environment.toUpperCase()}
          </span>
        </div>
        {preview && (
          <div className="share-summary__badges">
            {hasSshSecrets && (
              <span className="share-badge share-badge--secrets">SSH secretos</span>
            )}
            {preview.hasDatabasePassword && (
              <span className="share-badge share-badge--db">Contraseña BD</span>
            )}
            {preview.needsCredentials && (
              <span className="share-badge share-badge--warn">Sin credenciales</span>
            )}
          </div>
        )}
      </div>

      <dl className="share-summary__grid">
        <div>
          <dt>Endpoint SSH</dt>
          <dd>
            {profile.username}@{profile.host}:{profile.port}
          </dd>
        </div>
        <div>
          <dt>Autenticación</dt>
          <dd>{profile.authMethod === 'key' ? 'Clave SSH' : 'Contraseña SSH'}</dd>
        </div>
        {database && (
          <div>
            <dt>Destino BD</dt>
            <dd>
              {database.user}@{database.host}:{database.port} ({database.engine})
            </dd>
          </div>
        )}
        {hostKey && (
          <div>
            <dt>Huella servidor</dt>
            <dd className="share-summary__mono">{hostKey.fingerprint}</dd>
          </div>
        )}
        {preview?.keyPathHint && (
          <div>
            <dt>Pista de clave</dt>
            <dd className="share-summary__mono">{preview.keyPathHint}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
