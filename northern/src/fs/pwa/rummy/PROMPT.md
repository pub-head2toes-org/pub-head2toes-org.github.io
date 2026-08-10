# (PWA) Rummy

This is the implementation of the card game Rummy as progressive web app. Provide the implementation plan first. Break the plan into phases. The first phase need not have all game play mechanics and rules completed but rather give the first playable version.

* It should be coded as pure HTML, JS and CSS app.
* It is multi-player and the communication and synchronization is done through the HTTP PUT request for sending and listening to SSE messages
* Entry point is index.html with request parameters: participants, organizer, player, sse_link
  * example entry URL: <host>/pwa/rummy/index.html?participants=<CSV_list>&organizer=<STRING_VALUE>&player=<STRING_VALUE>&sse_link=<URL_STRING>
* Each player from the list of participants will be running it's own app instance
* If player == organizer then this sets the app instance that will have additional commands available for organizer to steer the game
  * Additional commands:
    * Deal cards
    * Start the first turn
    * Pause/Un-pause game
    * End game
* The whole experience should be rendered on just one page. So this can be also called a single page app
* App screen rendering:
  * First section: Game name (Rummy), Player (Blue Leader), Role (Organizer or Player), Pause button
  * Next section: Participants list (text area), Current player's turn (Blue One), Game clock (2:00 minutes), Additional commands list (text area, only available for organizer app instance)
  * Next section: Game chat message board (text area), message input field, button send
  * Next section: Table deck (text area), Selection deck (text area), Hand deck (text area)
  * Next section: Buttons corresponding to three decks above: Up, Down, Pick, Streak, Line, Lay, Esc
  * Next section: Abort play button, End turn button
* Play turn actions - allows the player to arrange cards in his hand and on the table to make the play
  * All actions are on the decks: Table, Selection, Hand
  * Each deck will have one card header in one line (7 spades OR 8 hearts, etc.)
  * Empty line separates streak of cards
  * The player can select a card from the deck by moving up/down
  * Pick - selected card will be removed from the deck and inserted into the selection deck
  * Streak will select and remove the streak of cards starting from selected card down to the empty line and put it into selection deck
  * Lay will take the cards from the selection deck and insert them at a selected position in the selected deck
* All action will emit an audit log that will be sent in the PUT request on the same URL used as SSE link URL
* On the received message over the SSE link the app state and rendering should be refreshed
* On page loading init the game state
  * Start listening to SSE messages
  * The organizer app instance does the state init and send the audit over the PUT requests
  * The players app instance listens for the initial state updates
  * The organizer inits:
    * set the random order of participants
    * fill in the playing cards set as a list of strings that represent card header (1 diamond, K hart, etc.)
      * two sets of 52 playing cards and 2 jokers, total of 106
* Common commands implemented as JS functions. Do audit over the PUT requests on each function execution
  * set_participants_random_order
  * deal_14_cards - picks random 14 cards from the deck for each participant
  * deal_1_card
  * get_current_game_state - table, participants, hands, current player, current time left for the play turn
  * start_next_turn
  * pause_game
  * end_game
