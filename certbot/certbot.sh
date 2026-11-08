#!/bin/sh
# Consigue y renueva el certificado de Let's Encrypt del dominio del ambiente.
# Corre en el servicio certbot del stack. Comparte con el proxy dos volúmenes:
#   /etc/letsencrypt  los certificados (certbot escribe, nginx lee);
#   /var/www/certbot  los archivos del desafío (certbot escribe, nginx sirve).
#
# Variables:
#   DOMINIO  dominio del ambiente (snippetsearcher-dev.duckdns.org…).
#   STAGING  1 = servidor de pruebas de Let's Encrypt (certificado no válido
#            para el navegador, pero sin límite de pedidos). 0 = el real.
set -eu

REAL=/etc/letsencrypt/live/$DOMINIO
RENOVACION=/etc/letsencrypt/renewal/$DOMINIO.conf
PROVISORIO=/etc/letsencrypt/provisorio
DESAFIOS=/var/www/certbot/.well-known/acme-challenge
if [ "$STAGING" = 1 ]; then
  SERVIDOR=https://acme-staging-v02.api.letsencrypt.org/directory
else
  SERVIDOR=https://acme-v02.api.letsencrypt.org/directory
fi

# Swarm manda SIGTERM al bajar el servicio: salir enseguida.
trap 'exit 0' TERM

dormir() {
  sleep "$1" &
  wait $!
}

# 1. Certificado provisorio: autofirmado, solo para que nginx pueda arrancar
#    con HTTPS antes de que exista el real. El navegador avisa que no es seguro.
if [ ! -f "$PROVISORIO/fullchain.pem" ]; then
  mkdir -p "$PROVISORIO"
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$DOMINIO" \
    -keyout "$PROVISORIO/privkey.pem" -out "$PROVISORIO/fullchain.pem"
  echo "certbot.sh: se creó el certificado provisorio"
fi

# 2. Antes de pedir el certificado, comprobar que Let's Encrypt va a poder
#    llegar al desafío: el dominio apunta a esta VM y el proxy responde en el
#    80. Cada pedido fallido cuenta para el límite de Let's Encrypt (5 por hora).
#    Se usa un texto al azar: si el pedido llega a otro lado (por ejemplo, a la
#    UI), no puede devolverlo por casualidad.
mkdir -p "$DESAFIOS"
prueba=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "$prueba" > "$DESAFIOS/prueba"
until [ "$(wget -q -O - "http://$DOMINIO/.well-known/acme-challenge/prueba" 2>/dev/null)" = "$prueba" ]; do
  echo "certbot.sh: todavía no se llega a http://$DOMINIO/.well-known/acme-challenge/"
  dormir 10
done
rm -f "$DESAFIOS/prueba"

# 3. Pedir el certificado si no existe, o si es de otro servidor (por ejemplo,
#    el de staging cuando ya se pasó al real). Si falla, esperar 10 minutos.
until [ -f "$REAL/fullchain.pem" ] && grep -q "^server = $SERVIDOR" "$RENOVACION"; do
  certbot certonly --webroot -w /var/www/certbot -d "$DOMINIO" --cert-name "$DOMINIO" \
    --server "$SERVIDOR" --non-interactive --agree-tos --register-unsafely-without-email \
    --force-renewal || dormir 600
done
echo "certbot.sh: certificado de $SERVIDOR listo"

# 4. Renovación: certbot renew solo renueva si faltan menos de 30 días. El
#    proxy nota el certificado nuevo y recarga nginx.
while :; do
  dormir 12h
  certbot renew --non-interactive || true
done
