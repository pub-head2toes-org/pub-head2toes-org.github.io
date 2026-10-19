# PWA Zine

A publication similar to a magazine but in electronic rather than printed form, maintained as data files on a computer and accessible via the world wide web as PWA.

# Built on top of PWA LoL
* Starts with the same code from PWA LoL
* With a following differences
  * Joining to allow anyone signed into Northern to join, using the username from the Northern cookie
  * No need to have `organizer` request parameter
  * No need to have `participant` request parameter
    * The list of participants will grow with each signed in Northern user joining
    * Limit to 100 participants, after which report joining error: `Lot full`
  * `sse_link` request parameter not needed and the value to default to `/sub/joint/zine`
  * `game_name` to be substitued with optional `issue` request parameter
    * Default value for `issue` to be `current`
    * The value for the `issue` parameter to be used to determine:
      * map file name in folder maps - default `current.png`
        * generate the same size image for the map as `dota_map.jpg`
        * simulate the open plan of some gallery with a bamboo hardwood floors
      * objects JSON file name in folder objects - default `current.json`
        * provide example objects of small and large size of type `obstacle` to look like picture frame that can be layed out on the floor rather than hanged on the wall
        * provide example objects of type `cover` with direction signs

