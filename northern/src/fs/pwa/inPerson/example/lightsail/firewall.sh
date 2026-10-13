#!/bin/sh
# coturn on Amazon Lightsail - see ../../PLAN.md, "Spike: coturn on Amazon Lightsail".
#
# Run on your own computer, with the AWS CLI signed in, after creating the
# instance (Ubuntu 24.04, a $5 IPv4 bundle is plenty):
#
#   INSTANCE=turn REGION=eu-central-1 ./firewall.sh
#
# It gives the instance a static IP - its address must never change, since
# coturn and the DNS record name it - and opens exactly the ports coturn uses.
# put-instance-public-ports REPLACES every IPv4 rule, so SSH and port 80 (for
# the certificate) are listed here too.
set -eu
: "${INSTANCE:?set INSTANCE, the Lightsail instance name}"
: "${REGION:?set REGION, e.g. eu-central-1}"
IP_NAME="${INSTANCE}-ip"

aws lightsail allocate-static-ip --region "$REGION" --static-ip-name "$IP_NAME" || true
aws lightsail attach-static-ip --region "$REGION" --static-ip-name "$IP_NAME" --instance-name "$INSTANCE"

aws lightsail put-instance-public-ports --region "$REGION" --instance-name "$INSTANCE" --port-infos \
  'fromPort=22,toPort=22,protocol=tcp' \
  'fromPort=80,toPort=80,protocol=tcp' \
  'fromPort=3478,toPort=3478,protocol=udp' \
  'fromPort=3478,toPort=3478,protocol=tcp' \
  'fromPort=443,toPort=443,protocol=tcp' \
  'fromPort=49160,toPort=49199,protocol=udp'

echo "Static IP (point turn.example.org at it, DNS only):"
aws lightsail get-static-ip --region "$REGION" --static-ip-name "$IP_NAME" --query 'staticIp.ipAddress' --output text
