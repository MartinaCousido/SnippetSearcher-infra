// Synthetics, alertas y dashboard de New Relic de Snippet Searcher, como
// código (#43). La cátedra baja un servicio, en dev o en prod, y evalúa que nos
// enteremos: una métrica lo marca, falla un synthetic, suena una alerta y el
// dashboard muestra qué falla. Ver "Observabilidad (New Relic)" en Decisiones
// técnicas de SnippetSearcher y "New Relic" en el README de este repo.
//
// Lee newrelic/.env (no se commitea): NEW_RELIC_API_KEY, NEW_RELIC_ACCOUNT_ID,
// NEW_RELIC_REGION, ALERT_EMAIL, SYNTHETICS_CLIENT_ID, SYNTHETICS_CLIENT_SECRET
// y PULUMI_CONFIG_PASSPHRASE.
import * as fs from "fs";
import * as newrelic from "@pulumi/newrelic";
import * as pulumi from "@pulumi/pulumi";

const accountId = requireEnv("NEW_RELIC_ACCOUNT_ID");
const alertEmail = requireEnv("ALERT_EMAIL");
const syntheticsClientId = requireEnv("SYNTHETICS_CLIENT_ID");
const syntheticsClientSecret = pulumi.secret(requireEnv("SYNTHETICS_CLIENT_SECRET"));

// El usuario de New Relic de Martina: la app del celular le avisa las alertas.
const mobileUserId = "1008817766";

// Los dos ambientes se monitorean igual.
const ambientes = ["dev", "prod"] as const;
type Ambiente = (typeof ambientes)[number];

// Los ambientes que ya mandan datos a New Relic. Uno que todavía no reporta
// (porque no llegó el pase a prod) se crea igual, pero apagado: synthetics en
// pausa, alertas desactivadas y sin avisos. Si no, avisaría que todo está caído.
const activos: ReadonlySet<Ambiente> = new Set(["dev"]);

// Los servicios con agente Java (APM). En New Relic se llaman "<servicio> (<ambiente>)".
const serviciosJava = ["snippet-service", "permission-service", "printscript-service", "asset-service"];

// Desde dónde corren los synthetics: dos regiones de Estados Unidos, cerca de las VMs.
const ubicaciones = ["US_EAST_1", "US_WEST_1"];

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Falta ${name} en newrelic/.env`);
    }
    return value;
}

const dominio = (ambiente: Ambiente) => `snippetsearcher-${ambiente}.duckdns.org`;

// --- Credencial de los synthetics ---------------------------------------------

// El secret de la app de Auth0 de los synthetics (sale de auth0/). El script lo
// lee como $secure.SNIPPETSEARCHER_SYNTHETICS_SECRET, sin que quede en el código.
new newrelic.synthetics.SecureCredential("synthetics-secret", {
    accountId,
    key: "SNIPPETSEARCHER_SYNTHETICS_SECRET",
    value: syntheticsClientSecret,
    description: "Secret de la app snippetsearcher-synthetics de Auth0 (client credentials)",
});

// --- Avisos: mail y app del celular -----------------------------------------------

const mail = new newrelic.NotificationDestination("mail", {
    accountId,
    name: "Mail de Martina",
    type: "EMAIL",
    properties: [{ key: "email", value: alertEmail }],
});

const celular = new newrelic.NotificationDestination("celular", {
    accountId,
    name: "App de New Relic de Martina",
    type: "MOBILE_PUSH",
    properties: [{ key: "userId", value: mobileUserId }],
});

const canalMail = new newrelic.NotificationChannel("canal-mail", {
    accountId,
    name: "Alertas de Snippet Searcher por mail",
    type: "EMAIL",
    product: "IINT",
    destinationId: mail.id,
    properties: [{ key: "subject", value: "Snippet Searcher: {{ issueTitle }}" }],
});

const canalCelular = new newrelic.NotificationChannel("canal-celular", {
    accountId,
    name: "Alertas de Snippet Searcher en el celular",
    type: "MOBILE_PUSH",
    product: "IINT",
    destinationId: celular.id,
    properties: [{ key: "", value: "" }],
});

// --- Por ambiente: synthetics, alertas y avisos ---------------------------------

// Un servicio sin datos durante este tiempo se da por caído.
const sinDatos = 180;

for (const ambiente of ambientes) {
    const base = `https://${dominio(ambiente)}`;
    const activo = activos.has(ambiente);
    const estado = activo ? "ENABLED" : "DISABLED";

    // Synthetics. Los simples (ping) corren cada minuto y no tienen límite en
    // el plan gratis: la UI y /api/health, que da DOWN si se cae la base,
    // Redis, Permission, PrintScript o el Asset Service.
    new newrelic.synthetics.Monitor(`ui-${ambiente}`, {
        accountId,
        name: `Snippet Searcher ${ambiente}: la UI responde`,
        type: "SIMPLE",
        uri: `${base}/`,
        period: "EVERY_MINUTE",
        status: estado,
        locationsPublics: ubicaciones,
        verifySsl: true,
        tags: [{ key: "environment", values: [ambiente] }],
    });

    new newrelic.synthetics.Monitor(`health-${ambiente}`, {
        accountId,
        name: `Snippet Searcher ${ambiente}: /api/health está UP`,
        type: "SIMPLE",
        uri: `${base}/api/health`,
        period: "EVERY_MINUTE",
        status: estado,
        locationsPublics: ubicaciones,
        validationString: "\"UP\"",
        verifySsl: true,
        tags: [{ key: "environment", values: [ambiente] }],
    });

    // El recorrido de un usuario: crear, leer y borrar un snippet. Los
    // chequeos de script sí tienen límite en el plan gratis: cada 6 horas.
    // Para la demo se puede correr a mano ("Run check").
    new newrelic.synthetics.ScriptMonitor(`snippet-${ambiente}`, {
        accountId,
        name: `Snippet Searcher ${ambiente}: crear, leer y borrar un snippet`,
        type: "SCRIPT_API",
        period: "EVERY_6_HOURS",
        status: estado,
        locationsPublics: [ubicaciones[0]],
        runtimeType: "NODE_API",
        runtimeTypeVersion: "16.10",
        scriptLanguage: "JAVASCRIPT",
        script: fs.readFileSync("synthetic-snippet.js", "utf8")
            .replaceAll("__BASE__", `${base}/api`)
            .replaceAll("__CLIENT_ID__", syntheticsClientId),
        tags: [{ key: "environment", values: [ambiente] }],
    });

    // Alertas. Una política por ambiente; un incidente por condición y por
    // servicio, así se ve cuál falló.
    const politica = new newrelic.AlertPolicy(`politica-${ambiente}`, {
        accountId,
        name: `Snippet Searcher ${ambiente}`,
        incidentPreference: "PER_CONDITION_AND_TARGET",
    });

    const condicion = (id: string, args: Omit<newrelic.NrqlAlertConditionArgs, "policyId" | "accountId">) =>
        new newrelic.NrqlAlertCondition(`${id}-${ambiente}`, {
            accountId,
            policyId: politica.id,
            type: "static",
            enabled: activo,
            violationTimeLimitSeconds: 86400,
            aggregationWindow: 60,
            aggregationMethod: "event_flow",
            aggregationDelay: "120",
            ...args,
        });

    // Servicio caído: el agente manda métricas cada minuto, aunque no haya
    // tráfico. Si deja de mandar, el servicio no está corriendo.
    const appsJava = serviciosJava.map(s => `'${s} (${ambiente})'`).join(", ");
    condicion("servicio-caido", {
        name: "Servicio caído: dejó de mandar datos",
        description: "Un servicio Java no manda métricas hace 3 minutos: está caído o reiniciándose. Ver el dashboard y sus logs.",
        nrql: { query: `SELECT count(newrelic.timeslice.value) FROM Metric WHERE appName IN (${appsJava}) FACET appName` },
        critical: { operator: "below", threshold: 1, thresholdDuration: sinDatos, thresholdOccurrences: "all" },
        expirationDuration: sinDatos,
        openViolationOnExpiration: true,
        closeViolationsOnExpiration: false,
    });

    // Contenedor caído: cualquier servicio del stack (también Postgres, Redis,
    // el proxy...) sin un contenedor corriendo.
    condicion("contenedor-caido", {
        name: "Contenedor caído: un servicio del stack no corre",
        description: "Un servicio del stack no tiene ningún contenedor corriendo hace 3 minutos.",
        nrql: { query: `SELECT uniqueCount(containerId) FROM ContainerSample WHERE environment = '${ambiente}' AND state = 'running' FACET \`label.com.docker.swarm.service.name\`` },
        critical: { operator: "below", threshold: 1, thresholdDuration: sinDatos, thresholdOccurrences: "all" },
        expirationDuration: sinDatos,
        openViolationOnExpiration: true,
        closeViolationsOnExpiration: false,
    });

    // La VM: si se cae, deja de mandar datos el agente de infraestructura.
    condicion("vm-caida", {
        name: "VM caída: dejó de mandar datos",
        description: `La VM ${ambiente} no manda datos hace 3 minutos: está apagada o sin red. Se caen todos los servicios y los puertos.`,
        nrql: { query: `SELECT count(*) FROM SystemSample WHERE displayName = 'snippetsearcher-${ambiente}'` },
        critical: { operator: "below", threshold: 1, thresholdDuration: sinDatos, thresholdOccurrences: "all" },
        expirationDuration: sinDatos,
        openViolationOnExpiration: true,
        closeViolationsOnExpiration: false,
    });

    for (const [id, campo, nombre] of [
        ["cpu", "cpuPercent", "CPU"],
        ["memoria", "memoryUsedPercent", "Memoria"],
        ["disco", "diskUsedPercent", "Disco"],
    ] as const) {
        condicion(`vm-${id}`, {
            name: `VM: ${nombre} por encima del 90 %`,
            description: `${nombre} de la VM ${ambiente} por encima del 90 % durante 5 minutos.`,
            nrql: { query: `SELECT max(${campo}) FROM SystemSample WHERE displayName = 'snippetsearcher-${ambiente}'` },
            critical: { operator: "above", threshold: 90, thresholdDuration: 300, thresholdOccurrences: "all" },
        });
    }

    // Errores y latencia de los servicios Java.
    condicion("errores", {
        name: "Errores: más del 5 % de los pedidos",
        description: "Un servicio responde con error más del 5 % de los pedidos durante 5 minutos.",
        nrql: { query: `SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName IN (${appsJava}) FACET appName` },
        critical: { operator: "above", threshold: 5, thresholdDuration: 300, thresholdOccurrences: "all" },
    });

    condicion("latencia", {
        name: "Latencia: p99 por encima de 2 segundos",
        description: "El 1 % más lento de los pedidos de un servicio tarda más de 2 segundos durante 5 minutos.",
        nrql: { query: `SELECT percentile(duration, 99) FROM Transaction WHERE appName IN (${appsJava}) FACET appName` },
        critical: { operator: "above", threshold: 2, thresholdDuration: 300, thresholdOccurrences: "all" },
    });

    // Synthetics que fallan: dos fallas en 3 minutos (no una sola, que puede
    // ser un problema de red de New Relic).
    condicion("synthetic", {
        name: "Synthetic que falla",
        description: "Un synthetic falló dos veces en 3 minutos: algo que le importa al usuario no anda.",
        nrql: { query: `SELECT count(*) FROM SyntheticCheck WHERE result = 'FAILED' AND monitorName LIKE 'Snippet Searcher ${ambiente}:%' FACET monitorName` },
        critical: { operator: "above_or_equals", threshold: 2, thresholdDuration: 180, thresholdOccurrences: "at_least_once" },
        slideBy: 60,
        aggregationWindow: 180,
        // Sin fallas no llega ningún dato: se cuenta como 0, así el incidente
        // se cierra solo cuando el synthetic vuelve a pasar.
        fillOption: "static",
        fillValue: 0,
    });

    // Saturación: mensajes de Redis que no se procesan.
    condicion("redis", {
        name: "Redis: más de 100 mensajes pendientes",
        description: "La cola de lint o formateo tiene más de 100 mensajes pendientes durante 5 minutos: el consumidor no da abasto o falla.",
        nrql: { query: `SELECT max(pending) FROM RedisStreamSample WHERE appName = 'snippet-service (${ambiente})' FACET stream` },
        critical: { operator: "above", threshold: 100, thresholdDuration: 300, thresholdOccurrences: "all" },
    });

    // Cada incidente de la política avisa por mail y en el celular.
    new newrelic.Workflow(`avisos-${ambiente}`, {
        accountId,
        name: `Snippet Searcher ${ambiente}: avisar`,
        enabled: activo,
        mutingRulesHandling: "NOTIFY_ALL_ISSUES",
        issuesFilter: {
            name: `Incidentes de Snippet Searcher ${ambiente}`,
            type: "FILTER",
            predicates: [{
                attribute: "labels.policyIds",
                operator: "EXACTLY_MATCHES",
                values: [politica.id],
            }],
        },
        destinations: [
            { channelId: canalMail.id },
            { channelId: canalCelular.id },
        ],
    });
}

// --- Dashboard -------------------------------------------------------------------

const consulta = (query: string) => [{ accountId, query }];

// Una página por ambiente, con lo mismo: de un vistazo, qué está fallando.
const pagina = (ambiente: Ambiente): newrelic.types.input.OneDashboardPage => {
    const apps = serviciosJava.map(s => `'${s} (${ambiente})'`).join(", ");
    const vm = `snippetsearcher-${ambiente}`;
    return {
        name: ambiente === "dev" ? "Dev" : "Prod",
        widgetTables: [
            {
                title: "Alertas abiertas",
                row: 1, column: 1, width: 6, height: 3,
                nrqlQueries: consulta(`SELECT latest(conditionName) AS 'Condición', latest(priority) AS 'Prioridad' FROM NrAiIncident WHERE policyName = 'Snippet Searcher ${ambiente}' AND event = 'open' FACET entity.name AS 'Qué' SINCE 1 day ago LIMIT 20`),
            },
            {
                title: "Contenedores corriendo por servicio (0 = caído)",
                row: 1, column: 7, width: 6, height: 3,
                nrqlQueries: consulta(`SELECT uniqueCount(containerId) AS 'Corriendo' FROM ContainerSample WHERE environment = '${ambiente}' AND state = 'running' FACET \`label.com.docker.swarm.service.name\` AS 'Servicio' SINCE 2 minutes ago LIMIT 20`),
            },
            {
                title: "Logs con error o advertencia",
                row: 7, column: 1, width: 12, height: 3,
                nrqlQueries: consulta(`SELECT timestamp, entity.name, service, level, message FROM Log WHERE (entity.name IN (${apps}) OR environment = '${ambiente}') AND (level IN ('ERROR', 'WARN', 'error', 'warn') OR message LIKE '%error%') SINCE 1 hour ago LIMIT 50`),
            },
        ],
        widgetBillboards: [
            {
                title: "Synthetics: % de chequeos que pasan (última hora)",
                row: 4, column: 1, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT percentage(count(*), WHERE result = 'SUCCESS') AS 'OK' FROM SyntheticCheck WHERE monitorName LIKE 'Snippet Searcher ${ambiente}:%' FACET monitorName SINCE 1 hour ago`),
                critical: "90",
                warning: "99",
            },
        ],
        widgetLines: [
            {
                title: "Pedidos por minuto",
                row: 4, column: 5, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT rate(count(*), 1 minute) FROM Transaction WHERE appName IN (${apps}) FACET appName TIMESERIES SINCE 1 hour ago`),
            },
            {
                title: "Errores (%)",
                row: 4, column: 9, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName IN (${apps}) FACET appName TIMESERIES SINCE 1 hour ago`),
            },
            {
                title: "Latencia p99 (segundos)",
                row: 10, column: 1, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT percentile(duration, 99) FROM Transaction WHERE appName IN (${apps}) FACET appName TIMESERIES SINCE 1 hour ago`),
            },
            {
                title: `VM ${vm}: CPU, memoria y disco (%)`,
                row: 10, column: 5, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT max(cpuPercent) AS 'CPU', max(memoryUsedPercent) AS 'Memoria', max(diskUsedPercent) AS 'Disco' FROM SystemSample WHERE displayName = '${vm}' TIMESERIES SINCE 1 hour ago`),
            },
            {
                title: "Redis: mensajes pendientes por stream",
                row: 10, column: 9, width: 4, height: 3,
                nrqlQueries: consulta(`SELECT max(pending) FROM RedisStreamSample WHERE appName = 'snippet-service (${ambiente})' FACET stream TIMESERIES SINCE 1 hour ago`),
            },
        ],
    };
};

const dashboard = new newrelic.OneDashboard("dashboard", {
    accountId,
    name: "Snippet Searcher",
    permissions: "public_read_only",
    pages: [pagina("dev"), pagina("prod")],
});

export const dashboardUrl = dashboard.permalink;
