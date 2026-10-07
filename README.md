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
| Snippet Service | [SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher) | A sumar |
| Postgres `snippets` | — (imagen oficial `postgres:17`) | A sumar |
| Permission Service | [SnippetPermission](https://github.com/MartinaCousido/SnippetPermission) | A sumar |
| Postgres `permisos` | — (imagen oficial `postgres:17`) | A sumar |
| PrintScript | Usa la librería [ingsis-interpreter](https://github.com/ingsis-ua/ingsis-interpreter) | ⏳ Pendiente: dónde vive el servicio que la expone por HTTP |
| Asset Service + bucket | — | ⏳ Pendiente: si lo provee la cátedra o se implementa |

## Decisiones técnicas

| Tema | Estado | Detalle |
|---|---|---|
| Orquestación | ✅ Definido | Docker Swarm con `docker-stack.yml` (compose `3.8`). Lo indica la cátedra |
| Ambientes | ✅ Definido | Dos VMs en Azure, **dev** y **prod**, con lo mismo. Lo indica la cátedra |
| Rama por ambiente | ✅ Definido | `dev` → VM de dev, `main` → VM de prod |
| Registry de imágenes | ✅ Definido | GHCR (GitHub Container Registry) |
| Deploy | ✅ Definido | Automático con GitHub Actions; nunca a mano en la VM |
| PrintScript | ⏳ Pendiente | Si el servicio que envuelve la librería va en un repo propio o dentro de otro |
| Asset Service / bucket | ⏳ Pendiente | Si lo provee la cátedra o se implementa |
| Reverse proxy | ⏳ Pendiente | Qué expone el puerto 80 de la VM y cómo enruta a cada servicio |
| Secrets | ⏳ Pendiente | Qué secrets de GitHub hacen falta (IP de cada VM, clave SSH, credenciales de las bases) y sus nombres |

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

Igual que en el resto de los repos (ver [`CLAUDE.md` de SnippetSearcher](https://github.com/MartinaCousido/SnippetSearcher/blob/main/CLAUDE.md)):

```
feature/<descripcion>  ──PR──▶  dev  ──PR──▶  main
```

Acá el merge tiene un efecto directo: un merge a `dev` despliega en la VM de dev, y uno a `main` despliega en prod.
