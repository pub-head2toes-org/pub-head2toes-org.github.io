# PWA Rama

The PWA app that records audio notes to remember and remind later

## Considerations
* Use standard HTML 5, JS and CSS
* To record audio use HTML 5 audio API
* Save audio message in the browser IndexDB
* If the user is not signed into the Northern redirect to `Reg`
* UI
  * Main screen to have centered button `Record`
  * Right top corner to render the graphical button to "peel off" the top layer
    * On click action to graphical button is to render a second page with "search as type" field and two lists horizontally arranged
      * Right top corner to render the graphical button to "peel off" the bottom layer and return
      * `Search` field is the free entry field that reacts as user types in and keyword searches through all text attributes filtering the two lists below
      * Upper list to show reminders. Scrollable list.
      * Lower list to show all recordings in the "last recorded, first to show" order. Scrollable list.
        * On click on recording in the list:
          * Open an overlay with:
            * `Recording Timestamp` and `Play` button to play the recording with controls for pausing and positioning in recording
            * `Buzz` - short description
            * `Type` - "search as type" auto-select: Select from suggested types list: `TODO`, `Recipe`, `HOWTO`. Suggest list to expand with new type entries
            * `Reminder` - to trigger notification at a given time or date
            * `Essay` - long description
            * `Update` and `Close` buttons
