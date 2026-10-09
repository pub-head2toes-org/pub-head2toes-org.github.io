# PWA Pals - Update 6

The focus of this update is to improve UX and UI.

Objective: Improve small screen experience by distilling and moving less important data to the secondary layers. 

## Implementation considerations

* Remove app name from the main screen's first row
* Remove the "signed in" info and the link to "set up this device again" from the main page and replace it with a `gear` graphical button that will bring the `settings` layer and add there removed
* Move the `Log` panel to a separate layer that will be loaded on clicking at the pal in `Pals` panel
  * Rename `Log` to `Messages` and remove the link `show all`
* `Groups` panel should have the text `No groups` instead of the empty list 
* `Group members` to appear in a separate layer above the main page when clicked on group name
* Remove `Incoming messages` and redo the logic:
  * On the incoming message from a given user, update the pals list and put the bright green dot next to the pal's name
     * On the clicking on the pal name the dot indicator to be removed
* Move the version to the `settings` layer



