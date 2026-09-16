# Update 2

Focus on adding new features and changing some of the existing

# Considerations

* Changes in the existing implementation
  * Increase the size of all enemies for the factor of 2
  * Introduce acceleration/deceleration of the rocket when starting/stopping
  * Slow down the rate of progression of weapons firing frequency
  * Implement explosion animation as pixel dust for stroked obstacles 
* Introduction of levels
  * New level after 1000 points
  * Second level: Appearance of new foe: `Snake`
    * Render `Snake` as a bigger red triangle followed by overlapped smaller triangles (total of 10 triangles in the tail)
    * On its appearance animate it as showing a head first (red triangle) after which head starts moving and showing one by one of the triangles in its tail
    * Head to move in sinusoidal waves with often randomly spaced looping
    * Hit in any part of the tail should only color the triangle insides briefly to mark the hit, but no damage
    * Only hit in the head will reduce the size of the snake by 2 triangles before not tail left and the head explodes
    * After the head explodes the `Egg` is left to fly the same pattern as the head used to do
      * Egg is rendered as green oval
      * Egg will disappear after 5s
      * If collected by rocket will `Egg` will give 500 points
      * Egg can be shot by the rocket's weapons and take away 50 points from the score
  * Third level: `Circle` to start dropping new `Seeking mine` after the `Circle` is destroyed
    * `Seeking mine` is rendered as a red vertical oval that is animated as shape shifting to circle to horizontal oval and back  
    * It is 2 times faster than `Circle` and speed is progressively increasing proportionally to the score
    * It is constantly adjusting its course towards the rocket
    * After 5s mine explodes with a blast radius of 5 rocket's sizes clearing the area of all obstacles or destroying the rocket if in radius
    * Mine can be shot by rocket's weapons
  * Fourth and further levels: To be defined later
* Introduction of in-between levels phase: `Comet shower`
  * randomly positioned `Comet` objects
    * `Comet` specs
       * Rendered as sequence of 5 white overlapping circles, with decreasing diameters
       * Variable speed: 2 to 3 times the speed of the rocket
       * cannot be shot down with weapons of any kind
       * sparse
    * randomly selected direction
    * all flying in parallel
    * entering and exiting the viewing space
  * The comet shower lasts for 10s which increases with every next appearance by 5s

