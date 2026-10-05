# PWA Pals - Update 5

Focus on message reply and message correction

## Implementation considerations
* On each message in the `Log` list add next to the sender name additional bubble with three dots with light grey background color (...) as indicator that there are more actions when a message is clicked or touched
* On the message click:
  * If a message was incoming then add a new button on the bottom left: `Reply`
    * On `Reply` click:
      * expand the overlay with additional text area below the original message
      * change the `Reply` button to `Send` with action to combine the original message with one line separator with a new message and send it as a new message. Separation line can look like `--- Reply ---` 
  * For outgoing messages add a new button on the bottom left: `Correction`
    * On `Correction` click:
      * expand the overlay with additional text area below the original message with a copy of the original message for edit
      * change the `Correction` button to `Correct` with action to combine the original message with one line separator with new message and send it as a new message. Separation line can look like `--- Correction ---`
