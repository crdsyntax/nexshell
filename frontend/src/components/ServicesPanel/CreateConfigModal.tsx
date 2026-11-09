import { useMemo, useState } from 'react'
import { AlertIcon, FileIcon, FolderIcon, PlusIcon, XIcon } from '@/components/Icons'
import { serviceManager } from '@/services/services.service'
import { useAppStore } from '@/store/useAppStore'

interface CreateConfigModalProps {
  profileId: string
  serviceName: string
  configRoot: string
  directories: string[]
  initialDirectory?: string
  onClose: () => void
  onCreated: (newPath: string) => void
}

interface TemplatePreset {
  id: string
  label: string
  content: string
}

function getTemplates(service: string, domain: string): TemplatePreset[] {
  const d = domain.trim() || 'example.com'
  if (service === 'nginx') {
    return [
      {
        id: 'http-basic',
        label: 'HTTP Básico (Puerto 80)',
        content: `server {\n    listen 80;\n    server_name ${d} www.${d};\n\n    root /var/www/html;\n    index index.html index.htm;\n\n    location / {\n        try_files $uri $uri/ =404;\n    }\n\n    access_log /var/log/nginx/${d}.access.log;\n    error_log /var/log/nginx/${d}.error.log;\n}\n`,
      },
      {
        id: 'reverse-proxy',
        label: 'Proxy Inverso (Reverse Proxy)',
        content: `server {\n    listen 80;\n    server_name ${d};\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n        proxy_cache_bypass $http_upgrade;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n\n    access_log /var/log/nginx/${d}.access.log;\n    error_log /var/log/nginx/${d}.error.log;\n}\n`,
      },
      {
        id: 'redirect-https',
        label: 'Redirección HTTP a HTTPS',
        content: `server {\n    listen 80;\n    server_name ${d} www.${d};\n    return 301 https://$host$request_uri;\n}\n`,
      },
      {
        id: 'blank',
        label: 'En blanco (Personalizado)',
        content: `# Configuración para ${d}\n`,
      },
    ]
  }

  if (service === 'apache2') {
    return [
      {
        id: 'vhost-basic',
        label: 'VirtualHost HTTP (Puerto 80)',
        content: `<VirtualHost *:80>\n    ServerName ${d}\n    ServerAlias www.${d}\n    ServerAdmin webmaster@localhost\n    DocumentRoot /var/www/html\n\n    <Directory /var/www/html>\n        Options Indexes FollowSymLinks\n        AllowOverride All\n        Require all granted\n    </Directory>\n\n    ErrorLog \${APACHE_LOG_DIR}/${d}_error.log\n    CustomLog \${APACHE_LOG_DIR}/${d}_access.log combined\n</VirtualHost>\n`,
      },
      {
        id: 'vhost-proxy',
        label: 'VirtualHost Reverse Proxy',
        content: `<VirtualHost *:80>\n    ServerName ${d}\n    ProxyPreserveHost On\n    ProxyPass / http://127.0.0.1:3000/\n    ProxyPassReverse / http://127.0.0.1:3000/\n\n    ErrorLog \${APACHE_LOG_DIR}/${d}_error.log\n    CustomLog \${APACHE_LOG_DIR}/${d}_access.log combined\n</VirtualHost>\n`,
      },
      {
        id: 'blank',
        label: 'En blanco (Personalizado)',
        content: `# Configuración Apache para ${d}\n`,
      },
    ]
  }

  return [
    {
      id: 'httpd-vhost',
      label: 'VirtualHost HTTP (Puerto 80)',
      content: `<VirtualHost *:80>\n    ServerName ${d}\n    ServerAlias www.${d}\n    DocumentRoot "/var/www/html"\n\n    <Directory "/var/www/html">\n        AllowOverride All\n        Require all granted\n    </Directory>\n\n    ErrorLog "logs/${d}_error_log"\n    CustomLog "logs/${d}_access_log" common\n</VirtualHost>\n`,
    },
    {
      id: 'blank',
      label: 'En blanco (Personalizado)',
      content: `# Configuración HTTPD para ${d}\n`,
    },
  ]
}

export function CreateConfigModal({
  profileId,
  serviceName,
  configRoot,
  directories,
  initialDirectory,
  onClose,
  onCreated,
}: CreateConfigModalProps) {
  const pushToast = useAppStore((state) => state.pushToast)

  // Default directory selection
  const defaultDir = initialDirectory || (directories.includes(`${configRoot}/sites-available`)
    ? `${configRoot}/sites-available`
    : directories.includes(`${configRoot}/conf.d`)
      ? `${configRoot}/conf.d`
      : directories[0] || configRoot)

  const [targetDir, setTargetDir] = useState<string>(defaultDir)
  const [fileName, setFileName] = useState<string>('')
  const [domainName, setDomainName] = useState<string>('mi-sitio.com')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('http-basic')
  const [customContent, setCustomContent] = useState<string>('')
  const [enableSiteImmediately, setEnableSiteImmediately] = useState<boolean>(true)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const templates = useMemo(
    () => getTemplates(serviceName, domainName),
    [serviceName, domainName],
  )

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0]

  const activeContent = customContent || selectedTemplate?.content || ''

  const isSitesAvailable = targetDir.endsWith('/sites-available')

  const handleCreate = async () => {
    let cleanName = fileName.trim()
    if (!cleanName) {
      setErrorMessage('Introduce un nombre para el archivo de configuración.')
      return
    }

    // Automatically append .conf if user omitted an extension
    if (!cleanName.includes('.')) {
      cleanName = `${cleanName}.conf`
    }

    if (cleanName.includes('/') || cleanName.includes('\\') || cleanName.includes('..')) {
      setErrorMessage('El nombre de archivo no puede contener caracteres de ruta ni "..".')
      return
    }

    const fullPath = `${targetDir.replace(/\/+$/, '')}/${cleanName}`

    setSubmitting(true)
    setErrorMessage(null)

    try {
      // 1. Write the new configuration file and test syntax with automatic rollback
      const result = await serviceManager.configWrite(
        profileId,
        serviceName,
        fullPath,
        activeContent,
      )

      if (!result.ok) {
        setErrorMessage(
          result.output || 'La validación de sintaxis falló. El archivo no fue creado para evitar romper el servicio.',
        )
        setSubmitting(false)
        return
      }

      // 2. If in sites-available and immediate enablement is requested, create the symlink
      if (isSitesAvailable && enableSiteImmediately) {
        try {
          const symlinkRes = await serviceManager.configToggleSite(
            profileId,
            serviceName,
            cleanName,
            true,
          )
          if (!symlinkRes.ok) {
            pushToast('error', `Archivo creado, pero falló la habilitación en sites-enabled: ${symlinkRes.output}`)
          }
        } catch (symlinkErr) {
          pushToast('error', `Archivo creado, pero ocurrió un error al habilitar el enlace simbólico: ${String(symlinkErr)}`)
        }
      }

      pushToast('success', `Archivo ${cleanName} creado y validado correctamente.`)
      onCreated(fullPath)
      onClose()
    } catch (error) {
      setErrorMessage(String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Crear archivo de configuración">
      <div className="modal create-config-modal">
        <div className="modal__header">
          <div>
            <h2>
              Nuevo archivo de configuración
              <span className="panel__sub">{serviceName.toUpperCase()}</span>
            </h2>
            <p>Crea un archivo de configuración validado con verificación de sintaxis y rollback automático.</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar modal">
            <XIcon size={16} />
          </button>
        </div>

        <div className="modal__body">
          {errorMessage && (
            <div className="inline-alert inline-alert--error" style={{ marginBottom: 16 }}>
              <AlertIcon size={15} />
              <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{errorMessage}</div>
            </div>
          )}

          <div className="create-config-form">
            <div className="form-group">
              <label>
                <FolderIcon size={13} /> Carpeta de destino
              </label>
              <select
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                disabled={submitting}
              >
                {directories.map((dir) => {
                  const label = dir === configRoot
                    ? `Raíz (${dir})`
                    : `${dir.replace(configRoot + '/', '')} (${dir})`
                  return (
                    <option key={dir} value={dir}>
                      {label}
                    </option>
                  )
                })}
              </select>
              <span className="field-hint">
                Directorio donde se almacenará el archivo en el servidor.
              </span>
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 1.2 }}>
                <label>
                  <FileIcon size={13} /> Nombre del archivo
                </label>
                <input
                  type="text"
                  placeholder="ejemplo.com.conf"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  disabled={submitting}
                  spellCheck={false}
                />
              </div>

              <div className="form-group" style={{ flex: 1 }}>
                <label>Dominio o ServerName</label>
                <input
                  type="text"
                  placeholder="mi-dominio.com"
                  value={domainName}
                  onChange={(e) => setDomainName(e.target.value)}
                  disabled={submitting}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="form-group">
              <label>Plantilla inicial</label>
              <div className="template-chips">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`template-chip ${selectedTemplateId === tpl.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedTemplateId(tpl.id)
                      setCustomContent('')
                    }}
                    disabled={submitting}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            {isSitesAvailable && (
              <label className="checkbox-row" style={{ marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={enableSiteImmediately}
                  onChange={(e) => setEnableSiteImmediately(e.target.checked)}
                  disabled={submitting}
                />
                <span>Habilitar inmediatamente creando enlace simbólico en <code>sites-enabled/</code></span>
              </label>
            )}

            <div className="form-group" style={{ marginTop: 10 }}>
              <label>Vista previa del contenido</label>
              <textarea
                className="config-textarea template-preview-textarea"
                value={activeContent}
                onChange={(e) => setCustomContent(e.target.value)}
                disabled={submitting}
                spellCheck={false}
                rows={8}
              />
            </div>
          </div>
        </div>

        <div className="modal__footer">
          <div className="modal__footer-left">
            <span className="mono" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
              Destino: {targetDir}/{fileName || 'archivo.conf'}
            </span>
          </div>
          <div className="modal__footer-right">
            <button className="ghost-button" onClick={onClose} disabled={submitting}>
              Cancelar
            </button>
            <button
              className="primary-button"
              onClick={() => void handleCreate()}
              disabled={submitting || !fileName.trim()}
            >
              <PlusIcon size={14} />
              <span>{submitting ? 'Validando…' : 'Crear y probar archivo'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
