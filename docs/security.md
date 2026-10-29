# Seguridad

## 1. Activos

- Credenciales SSH (contraseña, clave privada, passphrase).
- Host keys de los servidores.
- Configuración de nginx/Apache y su disponibilidad.
- Integridad de los comandos ejecutados como root cuando `elevated` está activo.

## 2. Modelo de amenazas

| Amenaza | Vector | Mitigación |
| --- | --- | --- |
| Robo de credenciales en reposo | Lectura del archivo SQLite | AES-256-GCM; solo `secret_blob`; DB y clave 0600 |
| Ruta de clave manipulada | Path introducido a mano | Diálogo nativo + lectura local con `load_secret_key` |
| Fuga de credenciales a la UI | Eventos/comandos que serialicen el perfil | `skip_serializing` + `ProfileView` con flags |
| MITM | Host key distinta | Fingerprint SHA-256 fijado en el primer uso; mismatch → conexión rechazada |
| Inyección de comandos | Nombres de servicio/rutas maliciosas | Enums, `shell_quote`, validación de rutas |
| Path traversal | `../../etc/shadow` o symlink fuera del root | Prefijo `configRoot/`, rechazo de `..`, `readlink -f` contra el root |
| Config inválida | Error humano al editar | Backup + `configtest` + rollback automático |
| Escalada excesiva | `sudo sh -c` | `sudo -n <binario>` por comando; sin shell root |
| DoS del pool | Terminales ilimitadas | Tamaño máximo + timeout de adquisición |
| Salida remota gigante | Comando malicioso en `exec` | Límite de 4 MiB y timeout |
| Muerte de un proceso crítico | Acción sobre PID 1 o proceso ajeno | Rechazo de PID <= 1, confirmación y permisos del usuario |
| Borrado accidental de archivos | Acción desde el listado de archivos grandes | Confirmación explícita, rechazo de rutas virtuales y `rm` sin expansión glob |

## 3. Decisiones implementadas

### Credenciales

- Cifrado autenticado AES-256-GCM con nonce aleatorio por escritura.
- SQLite con WAL; la base y los sidecars `-wal`/`-shm` se fijan a `0600`.
- La clave maestra se genera con CSPRNG (`OsRng`) y se escribe con `0600` en Unix.
- Los secretos se descifran solo al construir una conexión o al hacer merge de un
  formulario; no se cachean en el frontend.
- El formulario muestra `hasPassword/hasPrivateKey/hasPassphrase`; dejar vacío conserva
  el valor almacenado.

### Host keys

- TOFU: primera conexión registra `host:port → fingerprint`.
- Cada conexión compara el fingerprint presentado.
- Un mismatch se registra en logs y el handshake se rechaza.

### Comandos

- Los servicios se identifican con `WebService` (nginx/apache2/httpd) y las acciones
  con `ServiceAction`; no se acepta texto libre para el binario.
- Rutas y argumentos pasan por `shell_quote` (comillas simples con escape).
- El contenido de configuración viaja en base64 para evitar interpretación por shell.
- `elevated` aplica `sudo -n` a cada binario, no a un script completo.

### Configuración

- Se valida el prefijo del `configRoot` y se rechaza `..`, `\n`, `\r`, `\0`.
- Se resuelve el path con `readlink -f` y se exige que el destino real siga dentro
  del `configRoot` (nginx `sites-enabled` son symlinks).
- Tamaño máximo de lectura/escritura: 1 MiB.
- Backup `*.2shell-<timestamp>.bak` antes de escribir.
- Si `configtest` falla, se restaura el backup y se devuelve la salida del test.

## 4. Riesgos residuales (prototipo)

1. **Clave maestra en archivo.** Un proceso local con acceso al usuario puede leerla.
   Producción: keyring del SO, Tauri Stronghold o HSM.
2. **TOFU sin diálogo.** No hay UI para aceptar una host key nueva o rotada; se rechaza.
3. **Sudoers amplio.** Permitir `tee`/`cp`/`systemctl` con argumentos arbitrarios otorga
   capacidades equivalentes a root. Producción: helper privilegiado con validación de
   ruta/acción, o polkit.
4. **Sin auditoría.** No hay registro firmado de comandos ejecutados.
5. **Contraseña en memoria.** `String` no se zeroiza; podría aparecer en un core dump.
   Producción: `secrecy`/`zeroize` en todo el ciclo.
6. **Terminal = acceso arbitrario.** El usuario SSH puede ejecutar cualquier comando
   permitido por su cuenta remota; es el comportamiento esperado de una terminal.
7. **Dependencias.** `russh`, `tauri`, `xterm` y el resto deben auditarse y fijarse.

## 5. Recomendaciones de despliegue

- Usuario SSH dedicado, sin shell de login si solo se usan comandos concretos.
- `authorized_keys` con `from=`, `command=` o `restrict` cuando aplique.
- Sudoers con rutas absolutas y, si es posible, un wrapper que valide argumentos.
- Rotación de credenciales y revisión de `known_hosts`.
- Ejecutar la app en una sesión de escritorio confiable; no compartir el equipo.
- Backups externos de la configuración además del backup automático.

## 6. Checklist antes de producción

- [ ] Sustituir `master.key` por keyring/Stronghold.
- [ ] Añadir diálogo de aceptación/rechazo de host keys.
- [ ] Implementar helper privilegiado con validación de rutas.
- [ ] Añadir `zeroize` a secretos y buffers.
- [x] Auditoría de comandos y cambios de configuración (log local SQLite).
- [ ] Firma/inmutabilidad de la auditoría y exportación.
- [ ] Tests de integración con un servidor SSH de prueba.
- [ ] Firma de binarios y actualizaciones.
