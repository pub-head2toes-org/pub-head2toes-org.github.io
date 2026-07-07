Develop a progressive web app (PWA) named `Muse` with following instructions

* Write the code using the pure HTML 5, JS and CSS
* App is to help searching through the table that can be defined in CSV file. Basic app features are as follows:
  * Search is to be triggered on the main page by starting typing
  * With every key typed the search results list should be formed with partial matches over the values in CSV string
  * arrow up and down should allow moving up and down through search results scrolling the result list if needed
  * enter key should open the detail screen that will show the details of all column values for the selected in a form of a new list
* Start with the main page `index.html`
  * If no data yet switch to the `upload.html` screen that will allow for selecting and uploading CSV file
    * file should be upon uploading pushed to a local storage line by line
    * each line in the upload is the CSV string and it should be set in HTML local storage
    * when CSV string is to be pushed to the local storage use composite key created from the pattern: "MUSE:<TS><LINE_NUMBER>"
      * <TS> - timestamp (as seconds since January 1, 1970 (Unix epoch))
      * <LINE_NUMBER> - line number in CSV upload
    * the value for the local storage should be the CSV string   
    * return to the main page after loading
  * If data is loaded start the main key listener loop
* The key listener loop considerations
  * On any alphanumeric key pressed add the key to the search key string and perform the search by partial matching search key against the lines in the local storage. Refresh the search result list on the main screen
  * On the `Space` key press start a new search key string which will in result start the array of search keys
  * Search keys array to be used in matching as OR operation: the result will have string included if any of the search keys are matching
  * On the `Esc` key press reset the search key array
  * On the `Tab` key press show the list of additional commands
  * On the arrow up or down key press move the selection of the row in the search results
  * On the enter key press show the details screen for the selected line in the search results
  * On the back space key press delete last character added to the search keyword but do not execute search or search result screen refresh
* Main screen is to have one or more implementations that can be selected in the app configuration
  * Implementation using the HTML tags `textarea` and `div` or `span`
    * The first section would be a `div` tag with id `keyword`
    * The next section that will take all available space below should be `textarea` with id `results`
    * `textarea should be read only
    * Initial selection is for the first line in the `textarea`; moving up or down should select text in the appropriate lines
  * Implementation using the HTML `canvas` tag
    * This will be implemented in the next development iteration
* Details screen `details.html` should consider the following:
  * The first section is a `div` that will show the composite key whose value is to be shown below. Example: "MUSE:<TS><LINE_NUMBER>"
  * The next section below is the `textarea` rendered as read only and should occupy the rest of the space
  * Lines in the `textarea` should be formed from the current CSV string from local storage and the header CSV in the following way:
    * CSV header should be remembered during the CSV file upload phase
    * CSV header and current CSV string from the local storage should be parsed to extract values in the temporary arrays
    * Each line should be in format: <COLUMN_HEADER> : <COLUMN_VALUE>
    * Initially the first line to be selected and on the arrow keys up or down the selection should move
    * Some of the columns could be set in the configuration as editable
  * `Esc` key should return to the main screen with search results
  * `Enter` key for the columns set as editable should open the edit page
* Edit page `edit.html` should have the following:
  * The first section should have the `div` with the column name and value the same as on the detail page
  * The second section should have the `input` field
  * `Esc` should return to the detail screen without saving the value and `Enter` key should do the same but with saving the new value in the local storage
* Download page `download.html` should consider:
  * The download page should be accessible from a list of additional commands that can be triggered with the `Tab` key on the main page.
  * Should form the CSV file from the values in the local storage and trigger download to the local file system
  * Download file name to be formed using this pattern: `MUSE_<TS>.csv` where the <TS> is a timestamp in seconds like before
* Additional commands page `additional.html` should consider:
  * It should be similar to search results page
  * Render one section that occupies all available screen space with read only `textarea`
  * Each line in the `textarea` will hold a handle that can be selected with arrow keys up or down and triggered with `Enter` key
  * First example is the download page 
  * `Esc` key to return to the main page


