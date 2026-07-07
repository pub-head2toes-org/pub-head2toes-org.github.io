Develop an update for progressive web app (PWA) named `Muse` with following instructions

* Add a new view setup page `viewSetup.html` with the following considerations
  * Similar to details page show all available columns from the CSV upload file in the `textarea` list with selection controlled with up/down arrows
  * Each line should have a format: `<COLUMN_NAME>: <ON_OFF> where `ON` means show the column, and `OFF` means no show in the main page search results
  * `Enter` key should toggle the `ON` and `OFF` for selected column
  * `ESC` key to return to the main page
* The new page should be added to the list of the additional commands
* Change the main page view results to consider the view setup in the following way:
  * parse the CSV string and based on column position and ON/OFF setup exclude the columns marked as OFF

