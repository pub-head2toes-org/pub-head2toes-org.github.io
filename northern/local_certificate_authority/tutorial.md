W3Tutorials.net
Toggle Menu
Nov 24, 2025

How to Create a Trusted Self-Signed SSL Certificate for Localhost (Express/Node.js): Fixing Browser Trust Issues in Chrome & IE
When developing web applications locally, using HTTPS is often necessary to test features like secure cookies, OAuth flows, or PWA capabilities. However, browsers like Chrome and Internet Explorer (IE) flag self-signed SSL certificates as "untrusted," blocking access with scary security warnings. This guide will walk you through creating a trusted self-signed SSL certificate for localhost using OpenSSL, configuring it with an Express/Node.js server, and ensuring browsers like Chrome and IE trust it—no more red warnings!

Table of Contents#
Prerequisites
Understanding Self-Signed vs. CA-Signed Certificates
Step 1: Generate a Local Certificate Authority (CA)
Step 2: Generate a Server Certificate Signed by Your CA
Step 3: Configure Express/Node.js to Use the Certificate
Step 4: Trust the CA in Chrome
Step 5: Trust the CA in Internet Explorer (IE)
Testing the Setup
Troubleshooting Common Issues
Conclusion
References
Prerequisites#
Before starting, ensure you have the following tools installed:

OpenSSL: A command-line tool for generating SSL certificates. Verify installation with openssl version in your terminal.
Download for Windows: OpenSSL binaries
macOS: Preinstalled (or via brew install openssl)
Linux: Preinstalled (or via sudo apt install openssl)
Node.js & npm: To run the Express server. Download from nodejs.org.
Basic familiarity with the command line and Express.js.
Understanding Self-Signed vs. CA-Signed Certificates#
Self-Signed Certificates: Generated and signed by you (the user). Browsers distrust them because they aren’t verified by a trusted third party (a Certificate Authority, or CA).
CA-Signed Certificates: Signed by a trusted CA (e.g., Let’s Encrypt). Browsers preinstall root certificates from trusted CAs, so they automatically trust certificates signed by these CAs.
To make browsers trust your local certificate, we’ll create our own local CA and sign a server certificate with it. By installing our CA’s root certificate into the browser’s "Trusted Root" store, the server certificate (signed by our CA) will be trusted.

Step 1: Generate a Local Certificate Authority (CA)#
A CA acts as a trusted issuer. We’ll first create a private key and root certificate for our local CA.

1.1 Create a CA Private Key#
Run this command to generate a 2048-bit RSA private key for your CA. You’ll be prompted to set a password (store this securely!):

openssl genrsa -des3 -out rootCA.key 2048
1.2 Generate a CA Root Certificate#
Use the private key to create a self-signed root certificate (valid for 10 years, adjust -days as needed):

openssl req -x509 -new -nodes -key rootCA.key -sha256 -days 3650 -out rootCA.pem
When prompted, fill in the details:

Common Name (CN): Use "Local CA" (or any name to identify your CA).
Leave other fields (Country, State, etc.) blank or fill them arbitrarily (they don’t affect local trust).
You’ll now have two files:

rootCA.key: CA private key (keep this secure!).
rootCA.pem: CA root certificate (we’ll install this in browsers later).
Step 2: Generate a Server Certificate Signed by Your CA#
Next, create a certificate for localhost and sign it with your CA. This ensures browsers trust it.

2.1 Create a Server Private Key#
Generate a private key for your Express server:

openssl genrsa -out server.key 2048
2.2 Create a Certificate Signing Request (CSR)#
A CSR contains details about your server (e.g., domain name). Critical: Include localhost, 127.0.0.1, and ::1 (IPv6) as valid domains via Subject Alternative Names (SANs)—modern browsers require SANs even if the Common Name (CN) is set.

Option 1: Use a Config File (Recommended)#
Create a temporary OpenSSL config file (server.cnf) to define SANs:

[req]
prompt = no
default_bits = 2048
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
 
[req_distinguished_name]
CN = localhost
O = Local Development
 
[v3_ca]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
 
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
Generate the CSR using this config:

openssl req -new -key server.key -out server.csr -config server.cnf
Option 2: Command-Line SANs (Simpler)#
If you prefer not to use a config file, pass SANs directly (works in OpenSSL 1.1.1+):

openssl req -new -key server.key -out server.csr \
  -subj "/CN=localhost/O=Local Development" \
  -addext "subjectAltName = DNS:localhost, IP:127.0.0.1, IP:::1" \
  -addext "keyUsage = digitalSignature, keyEncipherment" \
  -addext "extendedKeyUsage = serverAuth" \
  -addext "basicConstraints = CA:FALSE"
2.3 Sign the Server CSR with Your CA#
Now, use your CA’s key and root certificate to sign the server CSR, generating the final server certificate (server.crt):

openssl x509 -req -in server.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial \
  -out server.crt -days 3650 -sha256 -extfile server.cnf -extensions v3_ca
-CA rootCA.pem: Your CA’s root certificate.
-CAkey rootCA.key: Your CA’s private key (you’ll need to enter the password set in Step 1.1).
-extfile server.cnf -extensions v3_ca: Applies the SANs and extensions from your config file.
You now have three server files:

server.key: Server private key.
server.csr: Certificate signing request (no longer needed).
server.crt: Signed server certificate (use this in Express).
Step 3: Configure Express/Node.js to Use the Certificate#
Now, set up an Express server to use your trusted certificate.

3.1 Create a Project and Install Dependencies#
mkdir express-ssl-demo && cd express-ssl-demo
npm init -y
npm install express
3.2 Write the Express Server Code#
Create server.js with the following code:

const https = require('https');
const fs = require('fs');
const express = require('express');
const app = express();
 
// Load SSL certificate and key
const options = {
  key: fs.readFileSync('../server.key'), // Path to your server.key
  cert: fs.readFileSync('../server.crt') // Path to your server.crt
};
 
// Test route
app.get('/', (req, res) => {
  res.send('✅ HTTPS is working! Browser should show a secure padlock.');
});
 
// Start HTTPS server on port 3000
https.createServer(options, app).listen(3000, () => {
  console.log('Server running at https://localhost:3000');
});
Note: Update ../server.key and ../server.crt to match the actual paths to your certificate files (e.g., if they’re in the same folder, use ./server.key).

Step 4: Trust the CA in Chrome#
To make Chrome trust your certificate, install your CA’s root certificate (rootCA.pem) into Chrome’s "Trusted Root Certification Authorities" store.

Windows#
Double-click rootCA.pem to open it.
Click "Install Certificate" → "Current User" → "Place all certificates in the following store".
Click "Browse" → Select "Trusted Root Certification Authorities" → "OK".
Click "Next" → "Finish". Accept the security warning.
macOS#
Open rootCA.pem (double-click or via open rootCA.pem).
Keychain Access will open. Select "System" in the left sidebar.
Drag rootCA.pem into the Keychain Access window.
Right-click the imported "Local CA" certificate → "Get Info".
Expand "Trust" → Set "When using this certificate" to "Always Trust".
Linux (Chrome/Chromium)#
Open Chrome → Go to chrome://settings/security.
Click "Manage certificates" → "Authorities" tab → "Import".
Select rootCA.pem → Check "Trust this certificate for identifying websites" → "OK".
Step 5: Trust the CA in Internet Explorer (IE)#
IE uses the Windows Certificate Store, so if you followed the Windows steps in Step 4, IE will already trust your CA.

To verify:

Open IE → Go to https://localhost:3000.
IE should display the page without security warnings (look for the padlock icon in the address bar).
Testing the Setup#
Start your Express server:
node server.js
Open Chrome or IE and navigate to https://localhost:3000.
Success: The browser should display a green padlock in the address bar, confirming the connection is secure.

Troubleshooting Common Issues#
"Your connection is not private" (NET::ERR_CERT_AUTHORITY_INVALID)#
Cause: The CA root certificate isn’t installed in the browser’s trusted store.
Fix: Reinstall rootCA.pem as described in Step 4.
"NET::ERR_CERT_COMMON_NAME_INVALID"#
Cause: Missing Subject Alternative Names (SANs) for localhost or 127.0.0.1.
Fix: Regenerate the server certificate with SANs (Step 2.2). Verify SANs with:
openssl x509 -in server.crt -text -noout | grep -A 1 "Subject Alternative Name"
"Error: ENOENT: no such file or directory"#
Cause: Incorrect paths to server.key or server.crt in server.js.
Fix: Use absolute paths (e.g., C:/path/to/server.key) or verify relative paths.
Conclusion#
By creating a local CA and signing a server certificate with it, you’ve eliminated browser trust issues for localhost development. This setup works for testing HTTPS-only features, secure cookies, and more—all without bypassing browser warnings.

References#
OpenSSL Documentation
Express.js HTTPS Guide
Chrome Certificate Management
IE Certificate Management
Subject Alternative Names (SANs) for SSL
2025-11

W3Tutorials.net
Terms
·
Privacy Policy
Company
About
© 2025 w3tutorials.net — tutorials, guides, and tools for developers. All rights reserved.
