# PWA game LoL - Lough out Loud

## Game description

### General considerations

* PWA - writen in pure HTML, JS and CSS
* Multi player - synced over SSE and HTTP PUT requests, as described in pwa/joint framework
* Main screen rendering using HTML canvas
* Text using 8 bit raster font
* Animation using the HTTP and canvas animated sequences and sprites
* Movement on the screen by point and click on the map
* The screen is just showing part of the big raster map. Use `maps/dota_map.jpg` as starting example.
* In the bottom right corner of the screen the small map with a location of the current window and other players on the big map is rendered
* On the bottom line of the screen the row of the icons for the abilities are lined up
* In the bottom left corner is a small icon of the blue British phone booth (like the one in Dr. Who) is the pull-up for chat overlay with the other players
* Zoom in/out icons are presented in the top right corner

### Phase 1 - Demo

* Start with the lobby screen to enter player name and button `Enter`
* After registering a player's name the click on the button will lead you into a main screen
* Player can do on the main screen:
  * start at the bottom left portion of the main map
  * walk around the map: point and click (or tap) on the location on the screen will start character walking towards and scrolling the window if required over the main map
  * ability icons are still empty frames
  * talk to others using the booth to bring chat pop-up overlay
  * see the animated sprite of the character while walking and standing
  * can zoom in/out the perspective of the visible screen that is currently visible to the player

