Progressive Web Application (PWA) Joint 

* this progressive web application's purpose is to allow easy on-boarding of multiple players or participants
* it should be codded in pure HTML, JS and CSS as Progressive Web Application (PWA)
* the first screen `index.html`
  * The first section is the title: `Joint` and subtitle: `Reception`
  * The next section is a span with two buttons: `Join` or `Organize`
* `join.html` page
  * First section is the title `Joint`
  * The next section is a sub-header: `Joining the party:`
  * The next section is input: `Organizer`
  * The next section is input: `Comm Channel`
  * The next section is input: `Participant`
  * The next section is input for the `game_name`
  * The next section is input for the `game_url`
  * The next section is a button: `Enter Lobby`
  * Actions
    * On page rendering check if any relevant HTTP parameters are present in the request: `[organizer, game_name, game_url, comm_channel]`
    * Fill in the values if parameters are present
* `organize.html` page
  * On page load generate the comm channel
    * Implement a function that can generate the comm channel string
    * Default implementation can be a string separated with dashes and representing the current date followed by a random number in range 1 to 64
      * Example: 2026-07-28-17 
    * First section is the title `Joint`
    * The second section is input for the `organizer`
    * The next section is input for the `game_name`
    * The next section is input for the `game_url`
    * The next section is a hidden input text with the `comm_channel` (needs to be generated on the page load)
    * The last section is a button for entering the lobby: `Enter Lobby`
* `lobby.html`page
  * rendering the page
    * verify required parameters are present: organizer, participant, game_name, game_url, comm_channel
      * Redirect to the error page if any of the parameters are missing
    * First section is the title `Joint`
    * The next section is a sub-header: `Lobby`
    * The next section is a read-only text area: `msg_board`
    * The next section is a span with text input: `msg` and button 'Send'
    * The last section has a div with two rows:
      * Read only text input with invite link
      * Button: `Start`
  * actions
    * On page rendering:
      * start the list of all participants
        * const participants = []
        * add to the list the participant from the request parameters
      * calculate the invite link
        * Example: `https://git.head2toes.org/pwa/joint/join.html?organizer=<>&game_name=<>&game_url=<>&comm_channel=<>`
        * Host: `https://git.head2toes.org` or `http://localhost`
        * Base URL: `/pwa/joint/join.html`
        * Parameters: `[organizer, game_name, game_url, comm_channel]`
        * All parameter values need to be URL encoded
      * calculate the SSE link
        * Example: `https://pub.head2toes.org/sub/joint/<COMM_CHANNEL>`
      * start listening for SSE messages on the SSE link
        * on message
          * parse the message as JSON
          * example JSON: `{"participant":"Blue Leader", "m":"Calling all cards"}`
          * add the participant from the message in the list participants if not present
          * append the message to the `msg_board` text area in format: <PARTICIPANT>: <MSG>
      * send lobby entry confirmation message to the comm_channel
        * Example: `PUT https://pub.head2toes.org/sub/joint/<COMM_CHANNEL>` with payload `{"participant":"Blue Member 1", "m":"Entered the Lobby"}
        * sending a message is executed over the HTML PUT request using the SSE link URL with payload as JSON
      * on pressing the `Send` button do send the message as similar to sending the lobby entry confirmation.
        * JSON: `{"participant":"<PARTICIPANT>", "m":"MSG"}`
        * Fill in the PARTICIPANT and MSG
        * Use the JSON message as payload for HTML PUT request on SSE link URL
    * Button `Start` is only available if organizer == participant
      * On pressing the button redirect in a new tab to the game_url
        * redirect should have HTTP parameters:
          * `participants` - string as coma separated list 
          * `organizer`
          * `sse_link`
