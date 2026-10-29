# Demo local de 2Shell

El host de demostración incluye OpenSSH, nginx y Apache sobre Ubuntu 24.04.
No usa systemd: sirve para comprobar el fallback a los scripts SysV `service`.

```bash
docker build -f dev/Dockerfile.demo -t 2shell-demo .
docker run --rm -p 2222:22 --name 2shell-demo 2shell-demo
```

En 2Shell crea un perfil:

| Campo | Valor |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `2222` |
| Username | `deploy` |
| Auth | password |
| Password | `deploy` |
| Elevated | activado (`sudo -n`) |

Prueba:

1. **Test connection** → Ubuntu 24.04, contenedor, nginx + apache2 instalados.
2. **Terminal** → `sudo systemctl` fallará (no hay systemd); usa `service nginx status`.
3. **Monitor** → CPU/RAM/procesos del contenedor.
4. **Services** → inicia nginx, edita `/etc/nginx/sites-enabled/default`, guarda y
   comprueba que `nginx -t` valida. Si introduces un error, el archivo se restaura.

> El contenedor es efímero. Los cambios de configuración desaparecen al borrarlo.
