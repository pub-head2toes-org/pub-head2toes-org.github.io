#!/bin/sh
# coturn on Amazon Lightsail - see ../../PLAN.md, "Spike: coturn on Amazon Lightsail".
#
# Run on the instance (Ubuntu 24.04), as root, once firewall.sh has attached
# the static IP and turn.example.org points at it:
#
#   sudo TURN_HOST=turn.example.org PUBLIC_IP=203.0.113.10 EMAIL=you@example.org \
#        SECRET="$(openssl rand -hex 32)" sh setup.sh
#
# SECRET is the static-auth-secret Northern is started with
# (NORTHERN_TURN_SECRET); keep a copy. Nothing on this server talks to
# Northern: the two only share that secret.
set -eu
: "${TURN_HOST:?set TURN_HOST}"
: "${PUBLIC_IP:?set PUBLIC_IP, the static IP}"
: "${EMAIL:?set EMAIL, for Let's Encrypt}"
: "${SECRET:?set SECRET}"
# Lightsail maps the static IP to the instance by NAT: the instance only
# has its private address, which coturn must be told beside the public one.
PRIVATE_IP="$(hostname -I | awk '{print $1}')"

apt-get update
apt-get install -y coturn certbot

# The certificate for turns:, by HTTP challenge on port 80 - which, unlike at
# home behind the tunnel, this server can answer itself.
certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$TURN_HOST"

# coturn runs as turnserver, which cannot read Let's Encrypt's private key:
# a copy it can read, renewed with the certificate.
mkdir -p /etc/coturn/certs /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/coturn.sh <<HOOK
#!/bin/sh
install -m 0644 -o turnserver -g turnserver /etc/letsencrypt/live/$TURN_HOST/fullchain.pem /etc/coturn/certs/fullchain.pem
install -m 0600 -o turnserver -g turnserver /etc/letsencrypt/live/$TURN_HOST/privkey.pem /etc/coturn/certs/privkey.pem
systemctl restart coturn
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh

cat > /etc/turnserver.conf <<CONF
# As ../coturn/turnserver.conf, for Lightsail.
listening-port=3478
# TLS on 443, not 5349: nothing else on this server needs 443, and some
# networks let nothing else out.
tls-listening-port=443
external-ip=$PUBLIC_IP/$PRIVATE_IP
min-port=49160
max-port=49199

realm=$TURN_HOST
use-auth-secret
static-auth-secret=$SECRET
fingerprint
stale-nonce=600
user-quota=12
total-quota=1200

cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
no-tlsv1
no-tlsv1_1

# Not to the instance's own network, nor to 169.254.169.254 - the metadata
# service, which answers anybody on the instance.
no-multicast-peers
no-tcp-relay
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

log-file=syslog
simple-log
CONF
chmod 0640 /etc/turnserver.conf
chgrp turnserver /etc/turnserver.conf

# 443 is below 1024: let the service bind it without running as root.
mkdir -p /etc/systemd/system/coturn.service.d
cat > /etc/systemd/system/coturn.service.d/override.conf <<UNIT
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
UNIT
# Older packages start only when told to.
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

/etc/letsencrypt/renewal-hooks/deploy/coturn.sh
systemctl daemon-reload
systemctl enable --now coturn
systemctl restart coturn
echo "coturn is up on $TURN_HOST ($PUBLIC_IP -> $PRIVATE_IP)."
