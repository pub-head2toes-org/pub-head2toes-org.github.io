# PWA LoL - UPDATE 2

## Common services to build upon

Clarification on using KV REST DB:

* DB to be used only for a specific use-cases
* Architecture focuses on distributed peer state persistence
  * late comers could ask for state update over the SSE channel and receive updates in SSE events sent by each participant or wait for the scheduled movement updates
  * movement updates should be sent periodically: even if stationary for prolonged time, the current position should be emitted with a frequency less than predefined value (500 ms)
  * if all participants got disconnected at once game state resets
* Persisting game state in KV DB can be developed at some later phase


## Phase 2 - considerations:

Clarification on movement audits and NPC bots

* Movement updates to be shared only through the SSE channel in this phase
* NPC bots in the first implementation to use the following simplifications:
  * will have only one example bot implementation to start with. Example: Winnie
  * the bot implementation to be saved at: `northern/src/fs/pwa/lol/bots.js
  * the bot prototype will be a JS object with functions: init, move
  * include `bots.js` in index.html
  * on index page loading:
    * start the game loop that will call the `init` and then in regular intervals call `move` function on registered bots
    * in the game loop include only bots that are listed in the participants list
    * when listed in the participants list use the following pattern: `Bot.<bot object name>`
      * example: `Bot.Winnie`
  * the game loop can be implemented as JS interval

