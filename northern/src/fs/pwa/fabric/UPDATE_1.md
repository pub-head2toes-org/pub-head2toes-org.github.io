# PWA Fabric - Update 1

Focus: Redo the current implementation at `src/fs/pwa/public/fabric`

Objective: Easier to use User Experience (UX) through redesign UI

# Considerations
* Current "one page" design has it all in `index.html`: the HTML canvas for drawing and the controls
  * First task is to separate this in two by introducing a two layers page with a graphical button in the top right corner, that will be "peeling off" the top layer that contains the HTML canvas and reveling the bottom layer with controls
    * On click on the graphical button should keep the selected objects on the canvas intact so that control like `Copy` will be able to work
    * Similar UX as the one used in the `src/fs/pwa/rama`
    * This changes will introduce the opportunity for the next round of improvements when the controls might be set in a remote device that will send the textual commands to the main device with control actions. These changes are to be done later.
  * Bottom layer with the controls to keep the same graphical button in the top right corner for "peeling off" bottom layer to return back to the top layer
    * Controls that use the slider to set the numerical values like `line with` adjust to use full width of the available screen estate
    * `Remove` control is at a current implementation only removing one selected object. Adjust it to be able to remove the all selected objects

 
