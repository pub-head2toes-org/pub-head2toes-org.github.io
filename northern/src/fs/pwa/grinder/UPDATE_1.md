# Update 1

Focus on PWA Grinder improvements

# Considerations

* Use matrix fonts and write all text on HTML canvas instead of using HTML tags
  * Look at `src/fs/pwa/grinder/example/` for an example of use of matrix fonts
* Use `Start` button to start the game on a welcome screen or game over screen
* On welcome screen loose the hight scores button. Instead alternate between welcome and high scores screens.
* Game over sceen should be alternate between game over title screen with a score and welcome screen
  * Introduce three letters initials entered using the gamepad if the score is in top five
* Move the torpedos trigger on L3 gamepad button
* Change the starting frequency for torpedo to 500ms
