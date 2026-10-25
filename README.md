# SnippetSearcher-infra

Repo de **infraestructura y deploy** de Snippet Searcher. Acá vive la configuración común a todos los servicios: qué servicios forman el sistema, cómo se conectan entre sí y cómo se despliegan en los ambientes de **dev** y **prod**.

No tiene código de ningún servicio. Cada servicio vive en su propio repo y publica su imagen Docker; este repo solo dice qué imágenes se levantan, con qué configuración y dónde.

La arquitectura, las user stories y las decisiones técnicas del sistema viven en el repo [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher), que es la fuente de verdad.

## Qué hace

- **Define el sistema completo** en un `docker-stack.yml` (formato compose `3.8`) que se despliega con **Docker Swarm**.
- **Conecta los servicios.** Todos los servicios del stack comparten una red y se encuentran por nombre. Por ejemplo, Snippet Service llega a Permission Service en `http://permission-service:8080`. Las URLs entre servicios se configuran acá, no en cada repo.
- **Despliega en las máquinas virtuales** de Azure, de forma automática y siempre desde GitHub.
- **Mantiene iguales los ambientes.** Dev y prod corren el mismo stack; solo cambian las variables de cada ambiente.

## Reglas

Las pidió la cátedra:

- **Las VMs no tienen código.** Solo tienen Docker y descargan las imágenes ya armadas.
- **Todo cambio queda versionado.** No se aplica ningún cambio a mano en una VM: todo entra por un push a GitHub, para tener trazabilidad.
- **Dev y prod tienen lo mismo.**
- **Cada repo actualiza solo lo suyo:**
  - un push a **este repo** vuelve a desplegar **todo** el stack;
  - un push al repo de un **servicio** actualiza **solo ese servicio**.

## Cómo se despliega

```
Repo de un servicio (SnippetSearcher, SnippetPermission, ...)
  push ──▶ GitHub Actions arma la imagen ──▶ la publica en GHCR
                                         ──▶ en la VM: docker service update (solo ese servicio)

Este repo (SnippetSearcher-infra)
  push ──▶ GitHub Actions ──▶ en la VM: docker stack deploy (todo el stack)
```

Las imágenes se publican en **GHCR** (GitHub Container Registry), el registry de imágenes Docker que viene con GitHub. De ahí las descargan las VMs.

## Ambientes

| Ambiente | Rama que lo actualiza | Dónde corre |
|---|---|---|
| **dev** | `dev` | VM de dev en Azure |
| **prod** | `main` | VM de prod en Azure |

Coincide con el flujo de trabajo de los repos: lo que se prueba en dev llega a prod con el PR `dev` → `main`.

## Servicios del stack

| Servicio | Repo | Estado |
|---|---|---|
| `proxy` | — (imagen oficial `nginx:1.30-alpine`) | ✅ En el stack. Reverse proxy: **único servicio con puertos públicos** (`80` y `443`). Ver [Reverse proxy](#reverse-proxy) y [HTTPS](#https) |
| `certbot` | — (imagen oficial `certbot/certbot:v5.8.0`) | ✅ En el stack. Consigue y renueva el certificado de HTTPS. Sin puertos. Ver [HTTPS](#https) |
| `ui` | [SnippetSearcher-ui](https://github.com/MartinaCousido/SnippetSearcher-ui) | ✅ En el stack (`ghcr.io/martinacousido/snippet-ui`). Sin puertos: el proxy le pasa `/`. La imagen la publica el repo de la UI ([SnippetSearcher-ui#10](https://github.com/MartinaCousido/SnippetSearcher-ui/issues/10)) |
| `snippet-service` | [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher) | ✅ En el stack. Sin puertos: el proxy le pasa `/api/` |
| `snippets-db` | — (imagen oficial `postgres:17`) | ✅ En el stack |
| `permission-service` | [SnippetPermission](https://github.com/MartinaCousido/SnippetPermission) | ✅ En el stack. Sin puertos: el proxy le pasa `/api/permissions/` |
| `permisos-db` | — (imagen oficial `postgres:17`) | ✅ En el stack |
| `printscript-service` | [SnippetPrintScript](https://github.com/MartinaCousido/SnippetPrintScript), que usa la librería [PrintScript](https://github.com/MartinaCousido/PrintScript) (`0.3.0`) | ✅ En el stack. Sin puerto público: Snippet Service lo llama en `http://printscript-service:8080` (variable `PRINTSCRIPT_SERVICE_URL`) |
| `asset-service` + `azurite` | [asset-service](https://github.com/austral-ingsis/asset-service) de la cátedra (imagen `ghcr.io/austral-ingsis/snippet-asset-service`) y la imagen oficial de Azurite | ✅ En el stack (`main.14` y Azurite `3.37.0`). Sin puertos públicos: Snippet Service lo llama en `http://asset-service:8080` (variable `ASSET_SERVICE_URL`). Los archivos quedan en el volumen `azurite-data` |
| `redis` | — (imagen oficial `redis:8.2`) | ✅ En el stack. Cola de mensajes (Redis Streams) de Snippet Service, que la encuentra con `SPRING_DATA_REDIS_HOST`. Con `appendonly` y el volumen `redis-data`: los mensajes pendientes sobreviven a un reinicio. Sin puertos públicos |

## Decisiones técnicas

| Tema | Estado | Detalle |
|---|---|---|
| Orquestación | ✅ Definido | Docker Swarm con `docker-stack.yml` (compose `3.8`). Lo indica la cátedra |
| Ambientes | ✅ Definido | Dos VMs en Azure, **dev** y **prod**, con lo mismo. Lo indica la cátedra |
| Rama por ambiente | ✅ Definido | `dev` → VM de dev, `main` → VM de prod |
| Registry de imágenes | ✅ Definido | GHCR (GitHub Container Registry) |
| Visibilidad de las imágenes | ✅ Definido | **Públicas.** La VM las descarga sin login ni token. Los repos también son públicos, así que no se expone nada nuevo |
| Puertos 80 y 443 de la VM | ✅ Definido | Los atiende el **`proxy`** (nginx), el único servicio con puertos públicos. Los demás servicios y las bases no se exponen: solo se ven por la red interna |
| Tags de las imágenes | ✅ Definido | Dos tags por imagen: el del ambiente y el del commit. Ver [Tags de las imágenes](#tags-de-las-imágenes) |
| Credenciales de las bases | ✅ Definido | El nombre y el usuario de cada base son fijos en el stack (`snippets` y `permisos`), porque no son secretos. Solo la **contraseña** va por variable. Ver [Variables del stack](#variables-del-stack) |
| Deploy | ✅ Definido | Automático con GitHub Actions; nunca a mano en la VM |
| PrintScript | ✅ Definido | Repo propio, [SnippetPrintScript](https://github.com/MartinaCousido/SnippetPrintScript), con el mismo flujo de deploy que los otros servicios. Ver [Servicio de PrintScript](https://github.com/MartinaCousido/SnippetSearcher#decisiones-técnicas) en SnippetSearcher |
| Asset Service / bucket | ✅ Definido | Lo provee la cátedra: el Asset Service sobre un bucket emulado con **Azurite**. Ver [Snippet Storage](https://github.com/MartinaCousido/SnippetSearcher#decisiones-técnicas) en SnippetSearcher. En el stack desde #14 |
| Reverse proxy | ✅ Definido | **nginx** en los puertos 80 y 443, con la configuración como Swarm `configs`. Ver [Reverse proxy](#reverse-proxy) |
| HTTPS | ✅ Definido | **Let's Encrypt + DuckDNS**: `snippetsearcher-dev.duckdns.org` y `snippetsearcher-prod.duckdns.org`. El cifrado termina en el `proxy`, en el puerto 443; adentro de la red de Docker se sigue con HTTP. El servicio `certbot` consigue el certificado; la primera vez, nginx arranca con uno **provisorio autofirmado**. Ver [HTTPS](#https) |
| CORS | ✅ Definido | Snippet Service y Permission Service aceptan solo los origins de la variable `CORS_ALLOWED_ORIGINS`, que se pasa en el stack (ver [Variables del stack](#variables-del-stack)). Dev: el dominio de dev y `http://localhost:5173`. Prod: solo el dominio de prod. Ver [CORS](https://github.com/MartinaCousido/SnippetSearcher#cors) en SnippetSearcher |
| Secrets | ✅ Definido | Cinco secrets en cada *Environment* de GitHub (`dev` y `prod`). Ver [Secrets](#secrets) |

### Variables del stack

`docker-stack.yml` es el mismo para dev y prod. Lo que cambia entre ambientes son cinco variables:

| Variable | Para qué | Ejemplo |
|---|---|---|
| `TAG` | Tag de las imágenes de los servicios | `dev` o `prod` |
| `SNIPPETS_DB_PASSWORD` | Contraseña de la base de Snippet Service | — |
| `PERMISOS_DB_PASSWORD` | Contraseña de la base de Permission Service | — |
| `CORS_ALLOWED_ORIGINS` | Origins que aceptan Snippet Service y Permission Service (ver [CORS](https://github.com/MartinaCousido/SnippetSearcher#cors)) | dev: `https://snippetsearcher-dev.duckdns.org,http://localhost:5173`. prod: `https://snippetsearcher-prod.duckdns.org` |
| `DOMINIO` | Dominio del ambiente: el del certificado y el de la redirección a HTTPS | `snippetsearcher-dev.duckdns.org` o `snippetsearcher-prod.duckdns.org` |

En las VMs, las pone el workflow de CD. `TAG`, `CORS_ALLOWED_ORIGINS` y `DOMINIO` no son secretos: salen de la rama, en `cd.yml`. Las contraseñas salen de los secrets del *Environment* de GitHub (`dev` o `prod`). Si falta alguna, el deploy se corta con un error que dice cuál.

Para validar el stack en tu máquina:

```bash
cp .env.example .env
set -a; source .env; set +a
docker stack config -c docker-stack.yml
```

### Tags de las imágenes

Cada push a `dev` o `main` publica la imagen del servicio con **dos tags a la vez**:

| Tag | Ejemplo | Para qué sirve |
|---|---|---|
| Ambiente | `ghcr.io/martinacousido/snippet-service:dev` o `:prod` | Cada VM pide el tag de su ambiente. Así dev y prod quedan separados: lo que se mergea a `dev` no llega a prod hasta el PR `dev` → `main` |
| Commit | `ghcr.io/martinacousido/snippet-service:sha-95da21f` | Es único por push. Dice exactamente qué código corre y permite volver a una versión anterior desplegando su `sha-` |

No se usa `latest`: no distingue ambientes y no permite saber qué versión está corriendo.

### Reverse proxy

El servicio `proxy` es un **nginx** que recibe todo en los puertos 80 y 443 y le pasa cada pedido al servicio que corresponde según la ruta. Sigue el modelo de la demo de la cátedra, [austral-ingsis/nginx-docker](https://github.com/austral-ingsis/nginx-docker). Las rutas están en [`nginx/default.conf`](nginx/default.conf).

| Ruta | Va a | Ejemplo |
|---|---|---|
| `/api/permissions/…` | `permission-service` | `/api/permissions/snippets` → `/permissions/snippets` |
| `/api/…` (`snippets`, `rules`, `languages`) | `snippet-service` | `/api/snippets` → `/snippets` |
| todo lo demás | `ui` | `/snippet/<id>` → `/snippet/<id>` |

- El proxy saca el `/api` antes de pasar el pedido: los servicios no conocen ese prefijo.
- La UI tiene una sola `BACKEND_URL` (`/api`, relativa a la página) y queda en la misma dirección que los servicios, así que el navegador no aplica CORS. Igual se configura en cada servicio: ver la fila **CORS** de [Decisiones técnicas](#decisiones-técnicas).
- Le pasa al servicio los headers `Host`, `X-Forwarded-For` (la IP del usuario) y `X-Forwarded-Proto` (si entró por HTTP o HTTPS).
- Acepta pedidos de hasta **5 MB** (`client_max_body_size`), para crear snippets desde un archivo (US-1). nginx trae 1 MB por defecto.
- Si un servicio está caído, responde **502** o **504** con una página propia ([`nginx/errores/no-disponible.html`](nginx/errores/no-disponible.html)), y el resto sigue andando. Espera hasta 5 segundos para conectarse a un servicio (`proxy_connect_timeout`), en lugar de los 60 que trae nginx.
- El puerto 80 solo atiende el desafío de Let's Encrypt y redirige todo lo demás a HTTPS (301). Ver [HTTPS](#https).
- `nginx/default.conf` es una plantilla: al arrancar, nginx reemplaza `${DOMINIO}` por el dominio del ambiente.

La decisión y el contrato completo están en [Contrato con la UI](https://github.com/MartinaCousido/SnippetSearcher#contrato-con-la-ui) de SnippetSearcher.

### HTTPS

El usuario entra por `https://<dominio>`. El cifrado termina en el `proxy`: a los servicios se les sigue hablando con HTTP, dentro de la red de Docker. El certificado lo da **Let's Encrypt**, gratis, y dura 90 días. Lo consigue y lo renueva el servicio **`certbot`** ([`certbot/certbot.sh`](certbot/certbot.sh)).

```
                 ┌──────────────────── VM ─────────────────────┐
navegador ─443─▶ │ proxy (nginx) ──HTTP──▶ ui, snippet-service… │
navegador ──80─▶ │   └─ 301 a https://<dominio>                 │
Let's Encrypt ─▶ │   └─ /.well-known/acme-challenge/ ◀─ certbot │
                 │      volúmenes: certificados, desafios-acme  │
                 └──────────────────────────────────────────────┘
```

Cómo se consigue el certificado:

1. **Provisorio.** nginx no arranca con HTTPS sin un certificado, y Let's Encrypt necesita a nginx para comprobar que el dominio es nuestro. Por eso, la primera vez, `certbot` crea un certificado **autofirmado** y nginx arranca con ese. El navegador avisa que no es seguro hasta que llega el real.
2. **Desafío.** `certbot` deja un archivo en el volumen `desafios-acme`, y el proxy lo sirve en `http://<dominio>/.well-known/acme-challenge/`. Let's Encrypt lo pide: si lo encuentra, el dominio es nuestro. Antes de pedir el certificado, `certbot` comprueba que ese archivo se ve desde afuera: cada pedido fallido cuenta para el límite de Let's Encrypt (5 por hora).
3. **Real.** `certbot` guarda el certificado en el volumen `certificados`. El proxy mira cada minuto si cambió ([`nginx/certificado.sh`](nginx/certificado.sh)) y recarga nginx, sin cortar.
4. **Renovación.** Cada 12 horas, `certbot renew` renueva el certificado si le faltan menos de 30 días. El proxy lo nota igual que en el paso 3.

- **Staging.** El servicio `certbot` usa el servidor real de Let's Encrypt (`STAGING: "0"`). Con `"1"` usa el de pruebas: no tiene límite de pedidos, pero el navegador no confía en su certificado. Sirve para probar un cambio en el flujo. Al volver a `"0"`, `certbot` pide el real y reemplaza el de pruebas.
- **HSTS.** El proxy le dice al navegador que use siempre HTTPS con el dominio, durante un año (`Strict-Transport-Security`).
- **La clave privada** (`privkey.pem`) vive solo en el volumen `certificados` de la VM. Nunca se commitea ni sale de la VM.
- La cuenta de Let's Encrypt se crea sin email.

#### Cambiar la configuración del proxy

Los archivos de `nginx/` y `certbot/` entran a los contenedores como **Swarm `configs`**: Swarm guarda una copia en la VM y no deja cambiarla. Por eso, cada vez que se edita uno de esos archivos, hay que subir la versión de su nombre en `docker-stack.yml`:

```yaml
configs:
  proxy_conf:
    name: snippet-searcher_proxy_conf_v2   # antes _v1
    file: ./nginx/default.conf
```

Si no se sube la versión, el deploy falla porque la config ya existe con otro contenido. Los archivos que no cambian quedan con su versión.

## Secrets

Viven en los *Environments* `dev` y `prod` de este repo (**Settings → Environments**). Cada Environment tiene los mismos nombres, con los valores de su VM. `dev` solo acepta deploys desde la rama `dev`, y `prod` solo desde `main`.

| Secret | Qué es |
|---|---|
| `VM_HOST` | IP pública de la VM |
| `VM_USER` | Usuario de la VM (`azureuser`) |
| `VM_SSH_KEY` | Contenido completo de la clave `.pem` de la VM |
| `SNIPPETS_DB_PASSWORD` | Contraseña de la base de Snippet Service |
| `PERMISOS_DB_PASSWORD` | Contraseña de la base de Permission Service |

- Las contraseñas solo pueden tener letras, números, `-`, `_` y `.`: el deploy las lee como variables de la terminal.
- Postgres toma la contraseña solo cuando crea la base. Cambiarla después obliga a borrar el volumen de la base en la VM, y con él los datos.

## Deploy automático

`.github/workflows/cd.yml` corre en cada push a `dev` o `main`:

1. Valida `docker-stack.yml` con `docker stack config`.
2. Entra a la VM por SSH con `VM_SSH_KEY`.
3. Copia `docker-stack.yml` y las carpetas `nginx/` y `certbot/` a `~/snippet-searcher/` en la VM.
4. Si `snippet-service` todavía publica el puerto 80, se lo saca. Pasa una sola vez por VM, en la primera vez que se despliega el proxy (#23): sin este paso, Swarm puede crear el proxy antes de liberar el puerto, y el deploy falla.
5. Corre `docker stack deploy --prune` con las variables del ambiente. `--prune` borra los servicios que ya no estén en el stack.
6. Espera hasta 5 minutos a que cada servicio esté en `1/1`. Si no llega, el workflow falla y muestra qué servicio no arrancó.

Para que funcione, **la VM tiene que estar prendida**. Si estaba apagada, se prende desde el portal de Azure y se vuelve a correr el workflow desde la pestaña *Actions* (**Re-run jobs**).

## Preparar una VM

Se hace una vez por ambiente, a mano, desde el portal de Azure y DuckDNS:

1. Crear la máquina virtual con el tamaño más barato, **IP pública** y acceso por **SSH** con un par de claves nuevo.
2. Abrir los **puertos 80 y 443**, y hacer **estática** la IP pública (si cambia, el dominio deja de apuntar a la VM).
3. En [DuckDNS](https://www.duckdns.org), crear el subdominio del ambiente (`snippetsearcher-dev` o `snippetsearcher-prod`) con la IP pública de la VM.
4. Entrar por SSH: `ssh -i <clave>.pem azureuser@<ip-publica>`.
5. Instalar Docker.
6. Inicializar Swarm: `docker swarm init`.

A partir de ahí, todo lo que corre en la VM lo despliegan los workflows de GitHub. La clave `.pem` **nunca** se commitea.

## Levantar el sistema en local

Este repo es para los ambientes desplegados. Para desarrollar en tu máquina a partir del código, seguí usando el `docker-compose.sistema.yml` del repo [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher#cómo-levantarlo).

## Flujo de trabajo

Es el mismo en los tres repos. La versión completa (cómo se mergea y cómo están protegidas `dev` y `main`) está en el [Flujo de trabajo de SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher#flujo-de-trabajo), que es la fuente de verdad:

```
feature/<descripcion>  ──PR──▶  dev  ──PR──▶  main
```

Acá el merge tiene un efecto directo: un merge a `dev` despliega en la VM de dev, y uno a `main` despliega en prod.
