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
| PrintScript | Usa la librería [ingsis-interpreter](https://github.com/ingsis-ua/ingsis-interpreter) | ⏳ Pendiente: dónde vive el servicio que la expone por HTTP |
| Asset Service + bucket | — | ⏳ Pendiente: si lo provee la cátedra o se implementa |
| UI web | [SnippetSearcher-ui](https://github.com/MartinaCousido/SnippetSearcher-ui) | ⏳ Pendiente: todavía no tiene imagen Docker ni está en el stack. Ver [Reverse proxy (pendiente)](#reverse-proxy-pendiente) |

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
| PrintScript | ⏳ Pendiente | Si el servicio que envuelve la librería va en un repo propio o dentro de otro |
| Asset Service / bucket | ⏳ Pendiente | Si lo provee la cátedra o se implementa |
| Reverse proxy | ⏳ Pendiente | Ver [Reverse proxy (pendiente)](#reverse-proxy-pendiente) |
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

### Reverse proxy (pendiente)

Hoy el puerto 80 lo atiende Snippet Service directo, porque es lo único que hay que exponer.

Cuando se sume la **UI web** (la provee la cátedra) y el login con **Auth0**, va a haber más de una cosa para exponer con un solo puerto. Ahí hace falta un *reverse proxy* (por ejemplo, nginx): recibe todo en el puerto 80 y deriva cada pedido al servicio que corresponde según la URL.

Queda para hacer **cuando la cátedra dé la UI y las herramientas necesarias** para configurarlo como corresponde. Agregarlo no rompe nada: se suma el proxy al stack y se le saca el puerto 80 a Snippet Service.

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
