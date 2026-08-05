# PWA game LoL - Lough out Loud

## Game description

### General considerations

* PWA
* Multi player - synced over SSE and HTTP PUT requests
* Main screen rendering using HTML canvas
* Text using 8 bit raster font
* Animation using the HTTP and canvas animated sequences and sprites
* Movement on the screen by point and click on the map
* The screen is just showing part of the big raster map
* In the bottom right corner of the screen the small map with a location of the current window and other players on the big map is rendered
* On the bottom line of the screen the row of the icons for the abilities are lined up
* In the bottom left corner is a small icon of the blue British phone booth (like the one in Dr. Who) is the pull-up for chat overlay with the other players
* Zoom in/out icons are presented in the top right corner

### Phase 1 - Demo

* Start with the lobby screen
* After registering a player's name the enter button will lead you into a main screen
* Player can 
  * walk around the map
  * ability icons are still empty frames
  * talk to others using the booth to bring chat pop-up overlay
  * see the animated sprite of the character while walking and standing
  * can zoom in/out the perspective of the visible screen that is currently visible to the player

