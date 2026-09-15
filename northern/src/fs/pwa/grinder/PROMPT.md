# PWA Grinder

This is a description for PWA Grinder: A look-a-like game to the Grid Wars game, rendered as PWA.

# Main components

* Main screen is taken by the HTML Canvas that takes all available screen estate
  * Canvas is 20% wider and longer than a visible screen (canvas point of view)
  * On init canvas is sprinkled with dots, random colored, random location, sparse
  * Canvas point of view will be scrolling opposite way of the rocket moving direction
* The rocket is initially rendered in the center of the canvas
  * Rendered as white triangle with a small red triangle in the top corner of the main triangle
  * Speed: fast
* HTML Gamepad API is used to control the rocket
  * left joystick - 2D movement on canvas
  * right joystick - the rocket spinning on its center axis
  * R2, R3 - laser and torpedoes
  * B - EMP bomb
* Rocket weapons
  * laser - a red line from the top of the red triangle in the direction of the rocket's pointer
    * initial frequency: 1 per second
      * line renders as long as not connecting with an obstacle: on connect the hit is registered and line is gone with next line only after cooling off period 
      * shouting frequency shortening as score increases
      * minimal frequency: 20 ms
  * torpedoes - a short bold orange line shot from in the similar way as a laser
    * initial frequency: 1 per second
      * shouting frequency shortening as score increases
      * minimal frequency: 20 ms
    * each torpedo trace as an individual object with speed and direction set
  * EMP bomb - electromagnetic pulse bomb
    * clears all obstacles at once
    * only 2 EMP bombs to start
* Foes - speed increases with the score 
  * triangles
    * appearance: 
      * initial frequency of appearing: 20s
      * from a random spot on canvas
      * comes as fleet of 10
      * shows as a dot and then grows in with each move until it reaches the full size (half size of the rocket)
      * each step in the movement path the direction is swaying randomly deviating a little from its previous course: triangle pointer defines the direction
      * speed can also vary a little randomly
      * color: yellow
    * speed: medium
  * squares
    * appearance:
      * initial frequency of appearing: 30s
      * random popping on the canvas
      * fleet of 5 but all appears individually with little delay
      * pointer for direction is through one of the diagonal
      * while moving it is slowly adjusting direction toward the position of the rocket
    * speed: slow
    * color: green
  * circles
    * appearance:
      * initial frequency of appearing: 60s
      * random pooping
      * just one at a time
      * shows as a dot and then increases diameter to a full size
      * size: as the rocket size
      * each hit decreases the diameter by 1/4 (takes 4 hits to disintegrate)
      * after a hit slowly increases diameter until full size; if hit comes before it grows by 1/4 of it full size then this growth and the 1/4 of the full size is subtracted 
    * speed: fast
    * color: orange
* Scoring
  * triangles: 5
  * squares: 10
  * circles: 100
* Other game screens
  * Welcome screen
  * High scores screen
  * Game over screen

