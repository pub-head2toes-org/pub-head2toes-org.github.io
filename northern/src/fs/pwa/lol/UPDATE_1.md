# PWA LoL - UPDATE 1

## Common services to build upon

* There is an available HTTP REST based database for persisting JSON
  * The request path is used as a key, and request body as a value for this key-value database
  * DB is available on a servernhosting the PWA
  * Special path prefix indicatest read only values served from the server's file system: `/fs/get`
* Call to HTTP POST with URL path and JSON payload will create record
* PUT will update
* GET will retrieve data
* This DB can be used for some data that PWA need to persists

  

## Phase 2 - considerations:

* Introduce the auditing the player location on the map with each movement
  * Movement audit is sent over HTTP PUT, like in case of Joint framework
* Introduce the listening on SSE channel for movement audits
  * Update the small map with a dot for each player current location
  * Each instance of LoL should keep the state object. Example: `const state = {}`
* Introduce NPC bots
  * NPC bot is the program implemented as JS function and can be run as standalone HTTP and SSE client
  * It has a name and other attributes like a user
  * It has location
  * Connects to LoL by listening to SSE channel for movement audits
  * It can independently move and send movement audit over HTTP put
  * Example implementation: A pet robot
    * It can roam like a free straight dog all over the map
    * It can remember places on the map
    * It can remember players
    * It can have a favorite player and it can move around in search to find it
    * It can follow a favorite player matching his moves
    * It can randomly switch and follow some other player


