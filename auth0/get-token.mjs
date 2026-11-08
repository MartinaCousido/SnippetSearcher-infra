// Muestra un access token de la API de Snippet Searcher, iniciando sesión en la
// página de login real de Auth0. Adaptado de la demo de la cátedra
// (austral-ingsis/auth0-integration, setup/get-token.mjs).
//
//   npm run token                                  # pide read:snippets write:snippets
//   npm run token -- "read:snippets"               # otros permisos, separados por espacios
//   export TOKEN=$(npm run --silent token)
//
// Flujo: Authorization Code + PKCE, el mismo que usa la UI. El token sale por
// stdout y todo lo demás por stderr, para poder guardarlo con $(...).

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...args) => console.error(...args);

// Dominio, audience y app salen de las salidas del stack de Pulumi.
function stackOutputs() {
    const pulumi = path.join(here, "node_modules", "pulumi", "run.js");
    try {
        const json = execFileSync(process.execPath, [pulumi, "stack", "output", "--json"], {
            cwd: here,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
        });
        return JSON.parse(json);
    } catch {
        log("No se pudieron leer las salidas de Pulumi. ¿Corriste `npm run up`?");
        process.exit(1);
    }
}

const outputs = stackOutputs();
const domain = outputs.AUTH0_DOMAIN;
const audience = outputs.AUTH0_AUDIENCE;
const clientId = outputs.tokenScriptClientId;
const redirectUri = outputs.tokenScriptCallbackUrl;
if (!clientId || !redirectUri) {
    log("El stack todavía no tiene la app del script: corré `npm run up`.");
    process.exit(1);
}
const scope = process.argv[2] ?? "read:snippets write:snippets";

// PKCE: un secreto al azar (verifier) queda acá; al navegador va solo su hash
// (challenge).
const base64url = (buffer) => buffer.toString("base64url");
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash("sha256").update(verifier).digest());
const state = base64url(randomBytes(16));

const authorizeUrl = new URL(`https://${domain}/authorize`);
authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    audience,
    ...(scope ? { scope } : {}),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "login", // siempre muestra el login, para poder elegir el usuario
}).toString();

const callback = new URL(redirectUri);

const server = createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== callback.pathname) {
        res.writeHead(404).end();
        return;
    }
    const finish = (status, message) => {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
            .end(message, () => server.closeAllConnections());
        server.close();
    };

    const error = url.searchParams.get("error");
    if (error) {
        finish(400, "Falló el login. Mirá la terminal.");
        log(`Falló el login: ${error}: ${url.searchParams.get("error_description")}`);
        process.exitCode = 1;
        return;
    }
    if (url.searchParams.get("state") !== state) {
        finish(400, "State inesperado. Mirá la terminal.");
        log("El state de la respuesta no coincide: se ignora.");
        process.exitCode = 1;
        return;
    }

    // Cambia el código de un solo uso (más el verifier de PKCE) por el token.
    let response;
    try {
        response = await fetch(`https://${domain}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                client_id: clientId,
                code: url.searchParams.get("code"),
                code_verifier: verifier,
                redirect_uri: redirectUri,
            }),
        });
    } catch (err) {
        finish(502, "No se pudo llegar a Auth0. Mirá la terminal.");
        log(`No se pudo llegar a https://${domain}/oauth/token: ${err.message}`);
        process.exitCode = 1;
        return;
    }
    const body = await response.json();
    if (!response.ok) {
        finish(500, "No se pudo conseguir el token. Mirá la terminal.");
        log(`Falló el pedido del token (${response.status}):`, body);
        process.exitCode = 1;
        return;
    }

    finish(200, "Listo. Podés cerrar esta pestaña y volver a la terminal.");

    const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
    log("\nDatos del access token:");
    log(`  sub:   ${claims.sub}`);
    log(`  aud:   ${[].concat(claims.aud).join(", ")}`);
    log(`  scope: ${claims.scope ?? "(ninguno)"}`);
    log(`  exp:   ${new Date(claims.exp * 1000).toLocaleString()}\n`);
    console.log(body.access_token);
});

server.on("error", (err) => {
    log(`No se pudo escuchar en ${callback.host}: ${err.message}`);
    process.exit(1);
});

server.listen(Number(callback.port), "localhost", () => {
    log("Abriendo el login de Auth0 en el navegador. Si no se abre, entrá a:\n");
    log(`  ${authorizeUrl}\n`);
    const opener = { darwin: "open", win32: "explorer" }[process.platform] ?? "xdg-open";
    spawn(opener, [authorizeUrl.toString()], { stdio: "ignore", detached: true })
        .on("error", () => {})
        .unref();
});

// Se rinde si nadie inicia sesión.
setTimeout(() => {
    log("Se terminó el tiempo de espera del login (2 minutos).");
    process.exit(1);
}, 120_000).unref();
