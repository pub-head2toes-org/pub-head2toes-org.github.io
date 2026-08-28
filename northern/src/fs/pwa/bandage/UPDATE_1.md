# UPDATE 1 (PWA) Bandage

Focus of this update is to introduce the recorder function

First, review the following details to consider, and then figure out the best plan to implement recorder functio and the  use of the `tinysynth` ability to play SMF.

## Details to consider

* implement play, record and edit function
* all functions to be set per one `loop` channel
* the "loop" channel:
  * a recording that can be played back in the background along with the keys inputs
  * an actual 4 channels for playing up to 4 notes at once (per one `loop` channel)
  * all notes played on one instrument
  * UI
    * use the reserved space to put up the table for a `loop` functions 
      * each table row to have function buttons:  `Play`, `Record`, `Edit`
      * 4 columns to represent the 4 `loop` channels
* the `Edit` function details:
  * show editor in the overlay in the reserved space
  * use table to show the notes, with 4 rows for the notes and the columns to form the sequence
  * columns to fit the reserved space width
  * the rows to represent the notes played at once
  * allow for moving left and right on the sheet
  * in each position allow for:
    * inserting or deleteing the empty bit
    * overwriting notes from keyboard input
    * do and undo of edit


