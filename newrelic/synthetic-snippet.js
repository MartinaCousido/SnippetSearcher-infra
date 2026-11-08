// Synthetic de New Relic (scripted API): el recorrido de un usuario contra un
// ambiente de Snippet Searcher. Crea un snippet, lo lee y lo borra. Si algún
// paso falla, el chequeo falla y suena la alerta "Synthetic que falla".
// Pulumi reemplaza __BASE__ (la API del ambiente) y __CLIENT_ID__ (la app de
// Auth0 snippetsearcher-synthetics); el secret es una credencial segura.
const assert = require("assert");

const BASE = "__BASE__";
const AUTH0 = "https://dev-eadjutr73y1lgdc5.us.auth0.com/oauth/token";

// $http con la API de request (callbacks), envuelta en una promesa.
function pedir(options) {
    return new Promise((resolve, reject) => {
        $http(options, (error, response, body) => (error ? reject(error) : resolve({ response, body })));
    });
}

async function main() {
    // 1. Un token para la API, con los permisos de leer y escribir.
    const token = await pedir({
        method: "POST",
        uri: AUTH0,
        json: {
            grant_type: "client_credentials",
            client_id: "__CLIENT_ID__",
            client_secret: $secure.SNIPPETSEARCHER_SYNTHETICS_SECRET,
            audience: "https://snippetsearcher-api",
        },
    });
    assert.strictEqual(token.response && token.response.statusCode, 200,
        "Auth0 no dio un token: " + (token.response && token.response.statusCode) + " " + JSON.stringify(token.body));
    const headers = {
        Authorization: "Bearer " + token.body.access_token,
        "X-Request-Id": "synthetic-" + Date.now(),
    };

    // 2. Crear: pasa por Snippet Service, PrintScript (valida), el Asset
    // Service (guarda el código) y Permission Service (registra el owner).
    const creado = await pedir({
        method: "POST",
        uri: BASE + "/snippets",
        headers,
        json: { name: "synthetic-" + Date.now(), content: "println(1);", language: "printscript" },
    });
    assert.strictEqual(creado.response.statusCode, 200, "No se pudo crear el snippet: " + JSON.stringify(creado.body));
    const id = creado.body.id;

    // 3. Leer: el código que se guardó.
    // Un GET no lleva cuerpo: la respuesta llega como texto y se lee como JSON.
    const leido = await pedir({ method: "GET", uri: BASE + "/snippets/" + id, headers });
    assert.strictEqual(leido.response.statusCode, 200, "No se pudo leer el snippet");
    const snippet = typeof leido.body === "string" ? JSON.parse(leido.body) : leido.body;
    assert.strictEqual(snippet.content, "println(1);", "El snippet no tiene el código que se guardó");

    // 4. Borrar: no deja basura.
    const borrado = await pedir({ method: "DELETE", uri: BASE + "/snippets/" + id, headers });
    assert.strictEqual(borrado.response.statusCode, 204, "No se pudo borrar el snippet");

    console.log("OK: se creó, leyó y borró el snippet " + id);
}

main().catch(error => {
    // Un error no capturado no siempre marca el chequeo como fallido: se fuerza.
    console.error(error);
    throw error;
});
