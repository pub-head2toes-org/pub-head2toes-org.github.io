# PWA Pals - Update 1

Focus on choosing the architecture details

## How to handle domain access
* A new `pals` subdomain is introduced: Ex. `https://pals.eastblue.stream/fs/get/pwa/pals/index.html`
* Store all data in local in browser Index DB

## Push API server support

* Introduce the server side Node JS class that will
  * On API init it loads the VAPID pub and private keys from Northern DB: `/push/api/config`
    * If the config is not found generate the VAPID keys and store them
    * Config to be JSON with the following:
      * VAPID pub key
      * VAPID private key
  * Introduce API endpoints:
    * GET endpoint: `/push/api/config/pub` - VAPID public key
    * POST endpoint: `/push/api/send` - for sending push notifications by calling the push provider endpoint for sending push notification
      * input: JSON payload that will include: 
        * receiver device subscription token
        * push provider ID (Ex. Google, Firefox, Apple, etc.)
        * message
        * sender - Northern pub key taken from the cookies
        * Seal the message before sending: use the derived AES key for VAPID private key and user pub key
    * POST endpoint: `/push/api/open` - for opening the sealed message
      * payload: JSON string with following:
        * sealed message
        * cookie with user pub key and signature
      * action and verification:
        * verify the user cookie
        * decrypt sealed message with AES key derived using the VAPID private key and user pub key
        * once decrypted, verify the sender pub key matches the current user pub key

## Message transport
* Use only short messages sent through the push notification payload
* Limit message length to 1000 chars
* Longer messages to be split across multiple push notifications

## Introduce the one time setup screen: `welcome.html`
* Prerequisite: Northern user logged in with username set
* Welcome screen UI
  * Centered panel
    * First row: Title: `Welcome Pal`
    * Next row: Description: `Let's get it started!`
    * Next row: Button: `Go`
      * On click action: Subscribe device for the Push API notification with the server VAPID
        * For successful subscription post the JSON into `/pals/<username>/<pub_key>` with attributes: device subscription token, push provider ID, Northern user pub key and username
      * Redirect to `index.html`   

## Invite link
* Remove the invite link section and logic implemented

## How to verify user identity
* Verify message sender pub key with the user pub key

## How to seal the messages
* Encrypt using the derived AES key based on the VAPID private key and user pub key (same mechanism as for encrypting the push message)

## How to handle groups
* Group is only a local list of pals stored by group name in browser Index DB 
* When a message is sent to a group:
  * message body to include prefix: `[<GROUP_NAME>]`
  * message is to be sent separately to each group member
  * upon receiving: a message to be placed in the group list of messages if prefix is present

## How to add pal
* Select a pal from the list of all pals in `/pals/`
  * Prepare a list from search JSON results for the path `/pals/%` by showing <username>(first_five_chars_in_pub) 

## How to send a message
* Pal or group needs to be selected
* Pull the pals params from DB path `/pals/username/pub`
* Invoke POST on `/push/api/send`
* Add a message to the `Log` list

