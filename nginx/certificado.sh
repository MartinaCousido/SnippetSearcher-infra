#!/bin/sh
# Elige el certificado del proxy y lo mantiene al día. Corre al arrancar el
# contenedor, antes que nginx (la imagen oficial corre /docker-entrypoint.d/*).
#
# certbot deja dos certificados en el volumen compartido /etc/letsencrypt:
#   - live/<dominio>: el de Let's Encrypt, cuando ya lo consiguió;
#   - provisorio:     uno autofirmado, para que nginx pueda arrancar la
#                     primera vez, antes de que exista el real.
# nginx lee siempre /etc/nginx/certificado, que apunta al real si existe y si
# no al provisorio. Cada minuto se vuelve a mirar: si cambió (llegó el real o
# se renovó), se recarga nginx.
set -eu

REAL=/etc/letsencrypt/live/$DOMINIO
PROVISORIO=/etc/letsencrypt/provisorio
ACTUAL=/etc/nginx/certificado
HUELLA=/tmp/huella-certificado

# Apunta ACTUAL al mejor certificado disponible. Devuelve 0 si cambió.
elegir() {
  if [ -f "$REAL/fullchain.pem" ]; then
    origen=$REAL
  elif [ -f "$PROVISORIO/fullchain.pem" ]; then
    origen=$PROVISORIO
  else
    return 1
  fi
  huella=$(md5sum "$origen/fullchain.pem" | cut -d' ' -f1)
  [ "$huella" != "$(cat "$HUELLA" 2>/dev/null)" ] || return 1
  ln -sfn "$origen" "$ACTUAL"
  echo "$huella" > "$HUELLA"
  echo "certificado.sh: nginx usa $origen"
}

# Al arrancar se elige siempre, aunque quede algo de una corrida anterior.
rm -f "$HUELLA"

# La primera vez, certbot puede tardar unos segundos en crear el provisorio.
# Si en 5 minutos no hay ninguno, el contenedor falla y Swarm lo reinicia.
espera=0
until elegir; do
  if [ "$espera" -ge 300 ]; then
    echo "certificado.sh: no hay certificado en /etc/letsencrypt" >&2
    exit 1
  fi
  sleep 2
  espera=$((espera + 2))
done

(
  while sleep 60; do
    if elegir; then
      nginx -s reload
    fi
  done
) &
