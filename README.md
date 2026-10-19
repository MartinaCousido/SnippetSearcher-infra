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
| `snippet-service` | [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher) | ✅ En el stack. Único servicio con puerto público (`80`) |
| `snippets-db` | — (imagen oficial `postgres:17`) | ✅ En el stack |
| `permission-service` | [SnippetPermission](https://github.com/MartinaCousido/SnippetPermission) | ✅ En el stack |
| `permisos-db` | — (imagen oficial `postgres:17`) | ✅ En el stack |
| `printscript-service` | [SnippetPrintScript](https://github.com/MartinaCousido/SnippetPrintScript), que usa la librería [PrintScript](https://github.com/MartinaCousido/PrintScript) (`0.3.0`) | ✅ En el stack. Sin puerto público: Snippet Service lo llama en `http://printscript-service:8080` (variable `PRINTSCRIPT_SERVICE_URL`) |
| `asset-service` + `azurite` | [asset-service](https://github.com/austral-ingsis/asset-service) de la cátedra (imagen `ghcr.io/austral-ingsis/snippet-asset-service`) y la imagen oficial de Azurite | ✅ En el stack (`main.14` y Azurite `3.37.0`). Sin puertos públicos: Snippet Service lo llama en `http://asset-service:8080` (variable `ASSET_SERVICE_URL`). Los archivos quedan en el volumen `azurite-data` |
| `redis` | — (imagen oficial `redis:8.2`) | ✅ En el stack. Cola de mensajes (Redis Streams) de Snippet Service, que la encuentra con `SPRING_DATA_REDIS_HOST`. Con `appendonly` y el volumen `redis-data`: los mensajes pendientes sobreviven a un reinicio. Sin puertos públicos |
| UI web | [SnippetSearcher-ui](https://github.com/MartinaCousido/SnippetSearcher-ui) | ⏳ Pendiente: todavía no tiene imagen Docker ni está en el stack. La va a servir el reverse proxy. Ver [Reverse proxy](#reverse-proxy) |

## Decisiones técnicas

| Tema | Estado | Detalle |
|---|---|---|
| Orquestación | ✅ Definido | Docker Swarm con `docker-stack.yml` (compose `3.8`). Lo indica la cátedra |
| Ambientes | ✅ Definido | Dos VMs en Azure, **dev** y **prod**, con lo mismo. Lo indica la cátedra |
| Rama por ambiente | ✅ Definido | `dev` → VM de dev, `main` → VM de prod |
| Registry de imágenes | ✅ Definido | GHCR (GitHub Container Registry) |
| Visibilidad de las imágenes | ✅ Definido | **Públicas.** La VM las descarga sin login ni token. Los repos también son públicos, así que no se expone nada nuevo |
| Puerto 80 de la VM | ✅ Definido | Lo atiende **Snippet Service directo** (`80:8080` en el stack). Permission Service y las bases no se exponen: solo se ven por la red interna |
| Tags de las imágenes | ✅ Definido | Dos tags por imagen: el del ambiente y el del commit. Ver [Tags de las imágenes](#tags-de-las-imágenes) |
| Credenciales de las bases | ✅ Definido | El nombre y el usuario de cada base son fijos en el stack (`snippets` y `permisos`), porque no son secretos. Solo la **contraseña** va por variable. Ver [Variables del stack](#variables-del-stack) |
| Deploy | ✅ Definido | Automático con GitHub Actions; nunca a mano en la VM |
| PrintScript | ✅ Definido | Repo propio, [SnippetPrintScript](https://github.com/MartinaCousido/SnippetPrintScript), con el mismo flujo de deploy que los otros servicios. Ver [Servicio de PrintScript](https://github.com/MartinaCousido/SnippetSearcher#decisiones-técnicas) en SnippetSearcher |
| Asset Service / bucket | ✅ Definido | Lo provee la cátedra: el Asset Service sobre un bucket emulado con **Azurite**. Ver [Snippet Storage](https://github.com/MartinaCousido/SnippetSearcher#decisiones-técnicas) en SnippetSearcher. En el stack desde #14 |
| Reverse proxy | ✅ Definido (falta implementarlo) | **nginx** en el puerto 80. Ver [Reverse proxy](#reverse-proxy) |
| Secrets | ✅ Definido | Cinco secrets en cada *Environment* de GitHub (`dev` y `prod`). Ver [Secrets](#secrets) |

### Variables del stack

`docker-stack.yml` es el mismo para dev y prod. Lo que cambia entre ambientes son tres variables:

| Variable | Para qué | Ejemplo |
|---|---|---|
| `TAG` | Tag de las imágenes de los servicios | `dev` o `prod` |
| `SNIPPETS_DB_PASSWORD` | Contraseña de la base de Snippet Service | — |
| `PERMISOS_DB_PASSWORD` | Contraseña de la base de Permission Service | — |

En las VMs, las pone el workflow de CD desde los secrets del *Environment* de GitHub (`dev` o `prod`). Si falta alguna, el deploy se corta con un error que dice cuál.

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

Hoy el puerto 80 lo atiende Snippet Service directo. Se va a reemplazar por un **reverse proxy con nginx**: un servicio más del stack que recibe todo en el puerto 80 y le pasa cada pedido al servicio que corresponde según la ruta.

| Ruta | Va a |
|---|---|
| `/api/snippets…`, `/api/rules…`, `/api/languages` | `snippet-service` |
| `/api/permissions…` | `permission-service` |
| todo lo demás | la UI web (archivos estáticos) |

- El proxy saca el `/api` antes de pasar el pedido: los servicios no conocen ese prefijo.
- La UI tiene una sola `BACKEND_URL` (`http://<vm>/api`) y queda en la misma dirección que los servicios, así que no hace falta CORS.
- Más adelante, el proxy es también el lugar para HTTPS, que probablemente pida el login con Auth0.

La decisión y el contrato completo están en [Contrato con la UI](https://github.com/MartinaCousido/SnippetSearcher#contrato-con-la-ui) de SnippetSearcher.

**Falta implementarlo.** Hace falta una imagen Docker de la UI y el servicio de nginx en el stack. Al sumarlo, Snippet Service deja de publicar el puerto 80.

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
3. Copia `docker-stack.yml` a `~/snippet-searcher/` en la VM.
4. Corre `docker stack deploy --prune` con las variables del ambiente. `--prune` borra los servicios que ya no estén en el stack.
5. Espera hasta 5 minutos a que cada servicio esté en `1/1`. Si no llega, el workflow falla y muestra qué servicio no arrancó.

Para que funcione, **la VM tiene que estar prendida**. Si estaba apagada, se prende desde el portal de Azure y se vuelve a correr el workflow desde la pestaña *Actions* (**Re-run jobs**).

## Preparar una VM

Se hace una vez por ambiente, a mano, desde el portal de Azure:

1. Crear la máquina virtual con el tamaño más barato, **IP pública** y acceso por **SSH** con un par de claves nuevo.
2. Abrir el **puerto 80**.
3. Entrar por SSH: `ssh -i <clave>.pem azureuser@<ip-publica>`.
4. Instalar Docker.
5. Inicializar Swarm: `docker swarm init`.

A partir de ahí, todo lo que corre en la VM lo despliegan los workflows de GitHub. La clave `.pem` **nunca** se commitea.

## Levantar el sistema en local

Este repo es para los ambientes desplegados. Para desarrollar en tu máquina a partir del código, seguí usando el `docker-compose.sistema.yml` del repo [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher#cómo-levantarlo).

## Flujo de trabajo

Es el mismo en los tres repos. La versión completa (cómo se mergea y cómo están protegidas `dev` y `main`) está en el [Flujo de trabajo de SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher#flujo-de-trabajo), que es la fuente de verdad:

```
feature/<descripcion>  ──PR──▶  dev  ──PR──▶  main
```

Acá el merge tiene un efecto directo: un merge a `dev` despliega en la VM de dev, y uno a `main` despliega en prod.
