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
| Fuga de topología remota | Consulta de titularidad de IP a terceros | Solo se envía la IP remota por HTTPS, al abrir el detalle de una conexión; nunca credenciales ni nombres de perfil |
| Bloqueo accidental de SSH | Activar un firewall sin permitir el puerto de administración | Se insertan las reglas SSH (22, puerto del perfil y puertos de sshd) antes de habilitar; el backend rechaza `deny` sobre esos puertos y se pide confirmación |
| Intento de conexión a la base de datos sin credenciales | Abrir el panel o refrescar sin contraseña | El panel muestra un formulario y no lanza ningún comando hasta que se envía una contraseña; el backend también rechaza credenciales vacías antes de ejecutar el cliente |

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

### Consultas externas

- IP local/WAN: `api.ipify.org`, `ifconfig.me` e `icanhazip.com`; solo con un clic o al
  refrescar la barra de estado.
- Titularidad de una IP remota: `ipwho.is` (ASN/geo), `ipinfo.io` (reverse DNS) y
  `rdap.org` (registro y contacto de abuso). Se ejecuta al abrir el detalle de tráfico;
  las IP privadas, loopback y link-local se excluyen.
- Todas las consultas usan HTTPS, timeout de 7 s, se tolera el fallo parcial de un
  proveedor y no incluyen secretos, usuario ni nombre del perfil.
- Diagnóstico de conexión: se ejecuta al abrir la pestaña Diagnóstico o al pulsar
  Reanalizar. Lee `ss`, `ps`, `/proc/<pid>`
  (cwd, exe, FDs y variables de entorno: valores redactados, o solo esquema/host/puerto
  cuando son URLs), `getent`,
  `lsof` y busca el IP/host/puerto en el directorio del proceso, mostrando solo
  `archivo:línea`. El sondeo TLS con `openssl s_client` es otra acción manual y solo
  envía un ClientHello al extremo remoto.

### Fail2ban

- Instalación y configuración solo con perfil `root` o `elevated`.
- El jail `sshd` se escribe en `/etc/fail2ban/jail.d/00-2shell.local`; el archivo
  anterior se copia a `/var/backups/2shell/fail2ban`.
- `ignoreip` incluye loopback por defecto y se valida cada IP/CIDR antes de escribir.
- Ban/unban se ejecuta con `fail2ban-client set sshd banip|unbanip` sobre una IP
  validada.
- La vista muestra fallos y baneos, pero nunca la contraseña ni el contenido de los
  intentos.

### Base de datos

- La contraseña de administración de MariaDB/MySQL solo existe en el estado del panel,
  en memoria; no va al store, a SQLite ni al portapapeles.
- Sin contraseña no se ejecuta `database_info`, `database_users` ni `database_grants`:
  el formulario inicial no dispara IPC.
- Las consultas usan `MYSQL_PWD` y `execute_sensitive`, por lo que el comando y la clave
  no se escriben en el audit log.
- `localhost` usa el socket; `127.0.0.1` fuerza TCP. El panel se puede desconectar y
  limpia la contraseña de la memoria.

### Firewall

- Solo se administra con un perfil `root` o `elevated` (`sudo -n`); la UI deshabilita
  las acciones si no hay privilegios.
- Antes de activar UFW o firewalld se permiten TCP en 22, en el puerto del perfil y en
  los puertos de `sshd -T`; después se aplica `deny incoming` / `allow outgoing`.
- El backend rechaza cualquier regla `deny` sobre los puertos SSH.
- Las reglas se validan: puerto 1–65535, protocolo tcp/udp/any y origen `any`,
  IPv4/IPv6 o CIDR.
- Al editar el origen de una regla UFW se añade primero la nueva y después se elimina
  la anterior; si SSH deja de estar permitido, UFW se desactiva y se devuelve error.
- «Mi IP» consulta la IP pública del equipo por HTTPS (`api64`/`api6.ipify` o
  `ipv6.icanhazip`) y solo rellena el origen; no cambia nada por sí sola.
- Backups del estado previo en `/var/backups/2shell/firewall`.
- Las reglas rich de firewalld se muestran como solo lectura.

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
