import * as pulumi from "@pulumi/pulumi";
import * as auth0 from "@pulumi/auth0";

// Recursos de Auth0 de Snippet Searcher (ver "Auth0" en el README de infra y
// "Auth0" y "Roles y permisos" en Decisiones técnicas de SnippetSearcher).
// Sigue el setup/ de la demo de la cátedra: austral-ingsis/auth0-integration.
//
// Todo sale de auth0/.env (ver .env.example), que cargan los scripts de npm.
// El proveedor de Auth0 lee solo AUTH0_DOMAIN, AUTH0_CLIENT_ID y
// AUTH0_CLIENT_SECRET (la app "pulumi").
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Falta ${name} en auth0/.env (ver .env.example)`);
    }
    return value;
}

const domain = requireEnv("AUTH0_DOMAIN");
const usersPassword = pulumi.secret(requireEnv("USUARIOS_PASSWORD"));

const audience = "https://snippetsearcher-api";
const readSnippets = "read:snippets";
const writeSnippets = "write:snippets";

// Desde dónde se usa la UI: local (Vite), dev y prod.
const uiOrigins = [
    "http://localhost:5173",
    "https://snippetsearcher-dev.duckdns.org",
    "https://snippetsearcher-prod.duckdns.org",
];

// --- API (los servicios) ---------------------------------------------------

const api = new auth0.ResourceServer("api", {
    name: "snippetsearcher-api",
    // Es el "aud" del token: los servicios rechazan tokens de otra API.
    identifier: audience,
    signingAlg: "RS256",
    // RBAC: Auth0 da un permiso solo si el usuario lo tiene por su rol. Sin
    // esto, le da cualquier permiso a cualquiera que lo pida.
    enforcePolicies: true,
    // La UI pide refresh tokens (ver la app de la UI).
    allowOfflineAccess: true,
    skipConsentForVerifiableFirstPartyClients: true,
});

const apiScopes = new auth0.ResourceServerScopes("api-scopes", {
    resourceServerIdentifier: api.identifier,
    scopes: [
        { name: readSnippets, description: "Ver snippets, sus tests y las reglas; correr tests y formatear sin guardar" },
        { name: writeSnippets, description: "Crear, editar, borrar y compartir snippets; crear y borrar tests; cambiar reglas" },
    ],
});

// --- Rol -------------------------------------------------------------------

// Hoy todos los usuarios reciben este rol, con los dos permisos. Si la cátedra
// pide roles distintos, se crean acá y se reparten los permisos.
const snippetUser = new auth0.Role("snippet-user", {
    name: "snippet-user",
    description: "Puede leer y escribir snippets. Lo reciben todos los usuarios",
});

new auth0.RolePermissions("snippet-user-permissions", {
    roleId: snippetUser.id,
    permissions: [readSnippets, writeSnippets].map(name => ({
        name,
        resourceServerIdentifier: api.identifier,
    })),
}, {
    // El permiso tiene que existir en la API antes de dárselo al rol.
    dependsOn: [apiScopes],
});

// --- Base de usuarios ------------------------------------------------------

// La base usuario y contraseña que viene con cada tenant.
const connectionName = "Username-Password-Authentication";
const connection = auth0.getConnectionOutput({ name: connectionName });

// --- App de la UI (SPA) ----------------------------------------------------

// SPA: corre entera en el navegador, así que no tiene secret. Inicia sesión
// con Authorization Code + PKCE (lo hace @auth0/auth0-react).
const ui = new auth0.Client("ui", {
    name: "snippetsearcher-ui",
    appType: "spa",
    oidcConformant: true,
    grantTypes: ["authorization_code", "refresh_token"],
    callbacks: uiOrigins,
    allowedLogoutUrls: uiOrigins,
    webOrigins: uiOrigins,
    allowedOrigins: uiOrigins,
    // Refresh tokens con rotación: la sesión no depende de cookies de
    // terceros, que los navegadores bloquean. Cada uso entrega uno nuevo.
    refreshToken: {
        rotationType: "rotating",
        expirationType: "expiring",
        leeway: 0,
        tokenLifetime: 2592000, // 30 días
        idleTokenLifetime: 1296000, // 15 días sin usarlo
        infiniteTokenLifetime: false,
        infiniteIdleTokenLifetime: false,
    },
});

new auth0.ConnectionClient("ui-connection", {
    connectionId: connection.id,
    clientId: ui.clientId,
});

// --- App para npm run token ------------------------------------------------

// Consigue un token desde la terminal, para probar los servicios con curl sin
// la UI (get-token.mjs). App pública (sin secret), como en la demo.
const tokenScriptCallback = "http://localhost:8485/callback";

const tokenScript = new auth0.Client("token-script", {
    name: "snippetsearcher-token-script",
    appType: "native",
    oidcConformant: true,
    grantTypes: ["authorization_code"],
    callbacks: [tokenScriptCallback],
});

new auth0.ConnectionClient("token-script-connection", {
    connectionId: connection.id,
    clientId: tokenScript.clientId,
});

// --- Rol por defecto: Action de login --------------------------------------

// App Machine to Machine que usa la Action para asignar el rol. Solo tiene
// el permiso de la Management API que necesita (update:users).
const roleAssigner = new auth0.Client("role-assigner", {
    name: "snippetsearcher-role-assigner",
    appType: "non_interactive",
    grantTypes: ["client_credentials"],
});

new auth0.ClientGrant("role-assigner-grant", {
    clientId: roleAssigner.clientId,
    audience: `https://${domain}/api/v2/`,
    scopes: ["update:users"],
});

const roleAssignerSecret = auth0
    .getClientOutput({ clientId: roleAssigner.clientId })
    .apply(client => pulumi.secret(client.clientSecret));

// En cada login: si el usuario no tiene ningún rol, le asigna snippet-user.
// Auth0 calcula los permisos del token antes de que corra la Action, así que
// en ese primer login los agrega a mano (solo los que la UI pidió).
// No usa librerías: llama a la Management API con fetch.
const defaultRoleCode = `
exports.onExecutePostLogin = async (event, api) => {
  // Usuarios de prueba que tienen que quedar sin rol (para ver el 403).
  if (event.user.app_metadata && event.user.app_metadata.sinRolPorDefecto) return;
  if (event.authorization && event.authorization.roles.length > 0) return;

  const domain = event.secrets.DOMAIN;
  const tokenResponse = await fetch(\`https://\${domain}/oauth/token\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: event.secrets.CLIENT_ID,
      client_secret: event.secrets.CLIENT_SECRET,
      audience: \`https://\${domain}/api/v2/\`,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(\`No se pudo pedir el token de la Management API: \${tokenResponse.status}\`);
  }
  const { access_token } = await tokenResponse.json();

  const userId = encodeURIComponent(event.user.user_id);
  const assignResponse = await fetch(\`https://\${domain}/api/v2/users/\${userId}/roles\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${access_token}\` },
    body: JSON.stringify({ roles: [event.secrets.ROLE_ID] }),
  });
  if (!assignResponse.ok) {
    throw new Error(\`No se pudo asignar el rol: \${assignResponse.status}\`);
  }

  // Los permisos del rol recién asignado, en este mismo token.
  if (event.resource_server && event.resource_server.identifier === event.secrets.AUDIENCE) {
    const requested = (event.transaction && event.transaction.requested_scopes) || [];
    for (const scope of event.secrets.ROLE_SCOPES.split(" ")) {
      if (requested.includes(scope)) api.accessToken.addScope(scope);
    }
  }
};
`;

const defaultRole = new auth0.Action("default-role", {
    name: "rol-por-defecto",
    runtime: "node22",
    deploy: true,
    supportedTriggers: { id: "post-login", version: "v3" },
    code: defaultRoleCode,
    secrets: [
        { name: "DOMAIN", value: domain },
        { name: "CLIENT_ID", value: roleAssigner.clientId },
        { name: "CLIENT_SECRET", value: roleAssignerSecret },
        { name: "ROLE_ID", value: snippetUser.id },
        { name: "AUDIENCE", value: audience },
        { name: "ROLE_SCOPES", value: `${readSnippets} ${writeSnippets}` },
    ],
});

new auth0.TriggerActions("post-login", {
    trigger: "post-login",
    actions: [{ id: defaultRole.id, displayName: defaultRole.name }],
});

// --- Usuarios de prueba ----------------------------------------------------

// Dos con el rol, para Cypress y para probar compartir, y uno sin rol, para
// ver el 403. Usan example.com: un dominio reservado, que nunca recibe mails.
function testUser(name: string, email: string, appMetadata?: object): auth0.User {
    return new auth0.User(name, {
        connectionName,
        email,
        emailVerified: true,
        password: usersPassword,
        appMetadata: appMetadata ? JSON.stringify(appMetadata) : undefined,
    });
}

const ana = testUser("ana", "ana@example.com");
const leo = testUser("leo", "leo@example.com");
const sinRol = testUser("sin-rol", "sin-rol@example.com", { sinRolPorDefecto: true });

for (const [name, user] of [["ana", ana], ["leo", leo]] as const) {
    new auth0.UserRoles(`${name}-roles`, {
        userId: user.id,
        roles: [snippetUser.id],
    });
}

// --- Salidas ---------------------------------------------------------------

// Lo que necesitan los servicios (AUTH0_DOMAIN y AUTH0_AUDIENCE), la UI
// (uiClientId) y get-token.mjs.
export const AUTH0_DOMAIN = domain;
export const AUTH0_AUDIENCE = api.identifier;
export const uiClientId = ui.clientId;
export const tokenScriptClientId = tokenScript.clientId;
export const tokenScriptCallbackUrl = tokenScriptCallback;
export const users = {
    conRol: [ana.email, leo.email],
    sinRol: sinRol.email,
};
