# Plan: (PWA) Grinder — a vector shooter for a gamepad

A single-page PWA under `/pwa/grinder/`: one canvas taking the whole window, a
rocket in the middle of it, and shapes that come at it from everywhere. The
pad flies and aims; the score buys a faster gun and faster foes, and the two
race each other until one of the shapes gets there. Nothing off the network,
nothing to install, nothing to join.

## Entry

`index.html` — no parameters, no network, no account. The table of high scores
is in `localStorage` and comes back with the page.

`error.html` is reached only when the browser has no `canvas`: the field, the
rocket and every shape that comes at it are drawn on one, so without it there
is nothing to show and nothing to fly.

## Architecture decisions

1. **The world is a fifth larger than the screen, and the camera is the
   scroll.** `world.js` holds one rectangle and one camera; the camera is
   centred on the rocket and then clamped inside the world, so all the travel
   it can ever have is that extra fifth. The rocket therefore sits still on the
   glass and the ground goes by the other way, which is what was asked for, and
   the whole of the scrolling is one `translate` in `render.js`. Nothing else
   in the app knows the screen and the world are different things.
2. **The dots are what make the scroll visible.** An empty black field gives
   the eye nothing to measure against and a rocket flat out looks like a rocket
   standing still. They are sprinkled once, they never move, and a resize
   carries them over in proportion rather than drawing a new sky under the
   player.
3. **The two sticks do two unrelated jobs.** The left stick is movement, plain
   and immediate — no thrust, no momentum, no turning. The right stick is the
   heading, and the heading is what both guns fire along. That is a twin-stick
   shooter and it is why `game.fly` and `game.aim` share nothing but the
   rocket.
4. **The right stick is read as a direction and answered with a turn.** The
   prompt asks for the rocket to spin on its centre axis; a rate control (push
   right, spin right) makes aiming a wrestle with a joystick, so the stick's
   direction is the heading asked for and the rocket turns towards it at
   `ROCKET.spin` radians a second. It is a spin about its centre either way,
   and a flick of the stick is answered as fast as the rocket can turn. Let the
   stick go and it keeps the heading it had: a gun that snapped back to
   forwards would be no gun.
5. **The laser is a standing line; a torpedo is a thing in flight.** The laser
   is not an object at all - while the trigger is down and the gun is not
   cooling there is a beam, re-aimed out of the nose every frame because the
   rocket has turned since the last one, drawn to the first foe in its path or
   off the edge of the world when there is none. The frame it meets something
   is the hit: the line goes out and the gun cools. A laser held on an empty
   sky is one long beam and no shots at all. A torpedo is the other way about -
   its own place, heading and speed, and once away the rocket has nothing more
   to do with it.
6. **A shot is tested over the line it crossed, not the point it landed on.** A
   torpedo covers a dozen pixels between frames and a triangle is thirteen
   across, so testing where it ended would let it pass clean through one. The
   same ray-against-circle arithmetic serves both guns: the laser asks it over
   a very long line and takes the nearest answer, a torpedo over the step it
   just took. One function, so the two guns cannot come to disagree about what
   counts as a hit.
7. **Every foe is the one object with a different entry in `foes.KIND`.** A
   position, a heading, a size, a count of hits left. What tells the three
   apart is the steering — a triangle wanders, a square leans towards the
   rocket, a circle holds its course — and the table carries everything else:
   colour, speed, score, how many to a fleet, how far apart they arrive, how
   often. Changing how often squares come is changing one number.
8. **Sizes are shares of the rocket, not pixels.** A triangle is half the
   rocket and a circle is the size of it, at any screen size and any density,
   because that is how the prompt reads and how the game reads on a phone.
9. **The circle's mending is a rule about what a hit takes, not about health.**
   A hit takes a quarter of its full diameter, and with it whatever it has
   grown back since the last hit — so mending counts for nothing unless a whole
   quarter is mended before the next shot lands, and the moment a whole quarter
   is back it is banked and cannot be taken twice. Four clean hits and there is
   nothing left. That is `foes.hit` and the mending branch of `foes.step`, and
   it is the one place in the game where the arithmetic is worth reading twice.
10. **Nothing arrives in the rocket's lap.** A fleet of ten that appears where
    the rocket is standing is not a wave, it is a verdict. Spots are drawn
    until one is six rocket-lengths off, and a spot that cannot be found is
    pushed out to that distance around the eight ways of the compass until one
    of them has the room. The scatter a fleet stands in goes through the same
    guard, because a fleet of ten is ten arrivals and any one of them could
    otherwise land on top of the rocket.
11. **The score is the difficulty.** The wait between shots halves every
    thousand points down to twenty milliseconds; foes gain a whole speed again
    every four thousand, capped at two and a half; the wait between waves
    halves every six thousand, floored at a third of where it started. Three
    curves, all read off the one number, all in the file that owns the thing
    they speed up.
12. **The game model touches no DOM and reads no clock.** `game.step` is given
    how long the frame was and what the player asked for, and that is all. So a
    test plays thirty seconds in a loop and reads the score off the end of it,
    and the page is free to clamp a frame — a tab left in the background comes
    back with a gap of minutes in it, and moving everything by minutes in one
    step would put the rocket through a wall and every foe on top of it.
13. **The torpedoes answer to R1 as well as R3.** R3 is the right stick
    pressed in - the same stick the rocket is aimed with. Pushing a stick
    straight down without leaning on it takes a firm thumb, and a thumb that
    leans swings the aim in the moment it fires, so the same gun is on R1 too:
    a button that can be pressed without letting go of the aim. R3 is what the
    prompt asks for and R3 still fires; R1 is so that firing is not a wrestle
    with the aiming.
14. **The pad says what it is sending.** A pad the browser does not report as a
    standard one sends its buttons at numbers of its own, and then R3 is not 11
    and the game sees nothing where the torpedoes should be - which looks
    exactly like a broken gun. The line on the menus names the buttons as they
    are pressed, so that case can be told apart from a bug without a debugger.
15. **The pad and the keyboard end in one object.** `input.read` takes what
    `navigator.getGamepads()` handed over and the set of keys currently down,
    and gives back one intent. Firing is held, the bomb is pressed — down now
    and not down when we last looked — because two of the two bombs on one
    thumb press is not a game. Nothing downstream of that function knows which
    was used.
16. **The menus are HTML, the game is canvas.** The welcome, the scores and the
    game over are plain sections lying over the field; they are shown and
    hidden and nothing is built at run time. The loop runs on them too, because
    the pad is read in it — a menu that only listened for clicks would be a
    menu you had to put the pad down to get out of. The stick walks the
    buttons, A presses the one it is standing on, and the focus ring is what
    says where it is.
17. **Nothing off the network.** No libraries, no fonts, no sounds. `sw.js`
    caches the eight scripts, the stylesheet, the page and the icons, so the
    game is played the same with the aeroplane mode on.

## Decisions the prompt left open

* **No lives.** One shape on the wing and the game is over. Nothing in the
  prompt buys a second chance, and it is what makes the two bombs worth
  holding on to.
* **A bomb scores what it clears.** It is the biggest score in the game if it
  is held until the screen is full, which is the only interesting decision a
  bomb can offer. It is refused on an empty sky rather than spent on nothing.
* **Two bombs, and no more.** "Only 2 EMP bombs to start" is read as the whole
  rule; nothing is awarded for a score, because no rule for awarding one was
  given.
* **Waves come closer together as the score climbs**, on the same reading of
  "initial frequency" as the guns, but only down to a third — past that the
  screen is a wall and there is no game in it.
* **The first fleet of triangles opens the game**; squares and circles keep to
  their own clocks from the start. A minute of an empty sky waiting for the
  first circle is a minute of nothing to do.
* **Foes bounce off the edge of the world** rather than leaving it or wrapping
  round. The world is small enough that leaving it would be leaving the game.
* **A full field puts the next wave off.** Ninety shapes at once is as many as
  the game will draw; the clocks go on running and the wave comes two seconds
  later instead. It is a guard for a player who shoots nothing, not a rule the
  game is played by.
* **No initials on a high score.** The game is played with a pad and a pad is a
  poor thing to spell a name on; the score and the day it was got say enough.
* **A keyboard plays it too** — W A S D to fly, the arrows to turn, space,
  shift and B. The prompt asks for a pad and the pad is the game; this is so
  the page can be opened on a laptop with nothing plugged in.

## Layout

```
+-----------------------------------------------------------+
| 1240  score      8400  best      <> <>  EMP                |   #hud, over the field
|                                                            |
|                     .        .          .                  |
|            /\                     [ ]                      |   foes, in world space
|                 <|            .                            |
|      .            \                                        |
|                    \___                                    |   the laser, nose to hit
|                      <| >                                  |   the rocket
|                                          O                 |
|          .                   .                             |
+-----------------------------------------------------------+
   the canvas is the window; the world is a fifth larger than it
```

## Files

| file | what it is |
| --- | --- |
| `index.html` | the canvas, the HUD, and the three screens that lie over it |
| `styles.css` | the screens, the HUD, and the colours the foes share with the canvas |
| `world.js` | the world, the camera, the dots, and everything that is a distance |
| `foes.js` | the three kinds: their table, how they arrive, how they move, what a hit does |
| `weapons.js` | the rate of fire, the ray arithmetic both guns use, the torpedo |
| `input.js` | the pad and the keyboard, read into one intent |
| `scores.js` | the top ten, in whatever store is handed over |
| `game.js` | the rocket, the waves, the shots, the score, and one frame of all of it |
| `render.js` | the painting, and the only place the screen and the world meet |
| `grinder.js` | the page: the screens, the loop, the wiring |
| `sw.js` | the cache, so it plays with the aeroplane mode on |
| `error.html` | for a browser with no canvas |

## Tests

`tests/grinder.test.js`, against `tests/helpers/grinderPage.js`.

The eight files that touch no DOM are loaded into one shared scope — the same
one the script tags give them — and tested as themselves: the world's
arithmetic, the circle's mending rule, the wave shapes, the rate of fire, the
tunnelling a torpedo must not do, the pad's dead zone and its press-not-hold
bomb, the table of scores, and a game played frame by frame through `game.step`.

`grinder.js` is tested through a stub DOM: the screens, the pad walking the
buttons, the hold on Escape, the score reaching the table, a resize, and a
browser with no canvas being sent to `error.html`. Nothing is drawn — the
canvas takes the calls and throws them away.
