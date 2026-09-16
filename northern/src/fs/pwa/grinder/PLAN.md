# Plan: (PWA) Grinder — a vector shooter for a gamepad

A single-page PWA under `/pwa/grinder/`: one canvas taking the whole window, a
rocket in the middle of it, and shapes that come at it from everywhere. The
pad flies and aims; the score buys a faster gun and faster foes, and the two
race each other until one of the shapes gets there. Every thousand points is a
level, and between one level and the next there is a comet shower to fly
through. Nothing off the network, nothing to install, nothing to join.

## Entry

`index.html` — no parameters, no network, no account. There is nothing on the
page but the canvas: every word the game says is drawn on it out of the matrix
font. The table of high scores is in `localStorage` and comes back with the
page.

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
13. **Both guns are on the triggers: R2 the laser, L2 the torpedoes.** Nothing
    asks a thumb to click a stick it is flying or aiming with, and a trigger is
    analogue, so either gun fires once its trigger is far enough in rather than
    only when it bottoms out. The torpedoes start at two a second rather than
    one and halve from there like the laser.
14. **The pad says what it is sending.** A pad the browser does not report as a
    standard one sends its buttons at numbers of its own, and then L2 is not 6
    and the game sees nothing where the torpedoes should be - which looks
    exactly like a broken gun. The last line of the welcome names the buttons as
    they are pressed, so that case can be told apart from a bug without a
    debugger; with no pad in the drawer the same line lists the keys instead.
15. **The pad and the keyboard end in one object.** `input.read` takes what
    `navigator.getGamepads()` handed over and the set of keys currently down,
    and gives back one intent. Firing is held, the bomb is pressed — down now
    and not down when we last looked — because two of the two bombs on one
    thumb press is not a game. Nothing downstream of that function knows which
    was used.
16. **Everything is drawn, including the writing.** There is one element on the
    page. The welcome, the table, the game over, the three letters and the
    score along the top are all drawn on the canvas out of `font8x8` — eight
    rows of eight dots a letter, each lit dot a little square with a gap round
    it. No HTML to keep in step with the game, no stylesheet that can hide a
    panel the game thinks is showing (which is exactly what did happen), and no
    font to fetch. A run of lit dots in a row is drawn as one rectangle, not
    one per dot: a screenful of writing is a few thousand dots and every one of
    them would otherwise be its own call, sixty times a second.
17. **A screen is a card, and a card is a list of lines.** `screens.js` works
    out what a screen says — the text, the size of each line against the others,
    the colour — and paints it second. So what any screen says can be read back
    without a canvas anywhere near it, which is how they are tested, and the
    layout is one measurement: the widest line against the window, the whole
    card against its height, take the smaller. The same card fills a television
    and fits on a phone with no second set of numbers for either.
18. **Two columns are made of spaces.** In a matrix font a space is exactly a
    column wide, so a two-column block is lines padded to one length — and they
    must all be *the same* length, because a card is centred a line at a time
    and lines of different lengths centre at different left edges. The mark
    under the letter being spelt is the same trick: the caret line is as long
    as the letters line, so centring the two puts the mark where it belongs.
19. **There is no menu to walk.** The cards come round on their own, a few
    seconds each, and Start is the only thing to press. That removes the focus
    ring, the stick walking buttons, and the question of what is selected when
    a card changes under it — a cabinet does not have a cursor.
20. **Nothing off the network.** No libraries, no web fonts, no sounds. `sw.js`
    caches the thirteen scripts, the stylesheet, the page and the icons, so the
    game is played the same with the aeroplane mode on.
21. **A foe is asked where it can be hit, not where it is.** `foes.spots` gives
    back a list of circles with a name each, and both guns and the collision
    walk that list. For a triangle it is one circle and the arithmetic is what
    it always was; for a snake it is a head and ten tail triangles, and the name
    is how `foes.hit` tells a hit that hurts from one that only lights up. No
    gun knows what a snake is.
22. **The rocket has weight, and the left stick asks for a speed.** The stick
    names a velocity and the rocket goes after it at `thrust`, and comes off it
    at `coast` when the stick is let go. It is still not steering and there is
    still no turning in it - what it buys is that a dodge costs something to
    begin and something to end. A wall takes the speed out of it in that
    direction rather than leaving it pressed against the edge.
23. **A level is a threshold, and the shower is what the threshold opens.** A
    thousand points does not turn the level over; it starts a comet shower, and
    the shower turning over is what turns the level over. So there is one place
    that knows a level has changed (`game.stage`) and one table that says what a
    level brings (`game.OPENS`), and the second level's snake starts arriving
    because that table says so and not because anything counted points.
24. **A comet is weather, not a foe, and lives in its own list.** "Cannot be
    shot down with weapons of any kind" is kept by keeping comets out of
    `state.foes` rather than by a check in each gun: there is nowhere for a
    weapon to look them up. They are the only things in the game that leave the
    world instead of bouncing off it, launched and swept up at the same distance
    out of the middle so a shower is as wide whichever way it runs.
25. **The snake's tail is not steered, it is laid down.** The head drops a crumb
    every four pixels and each triangle sits a fixed distance back along that
    trail, so the whole animal flies the exact path the head flew and the tail
    costs one interpolation each rather than ten steering decisions. The first
    crumb is always the head's own place, or the whole tail sits further back
    the faster the snake is going.
26. **What a hit took is what comes to pieces.** Every shape here is a stroke,
    so there is no inside to blow out - the outline becomes pixel dust in the
    shape's own colour, thrown off the line it was drawn on. `game.wound` reads
    the parts before the hit and after it, so a killing blow bursts the whole
    shape and a head hit on a snake bursts the two triangles it just took off
    the tail. A hit that took nothing leaves nothing.
27. **A mine's blast is the game's, not the mine's.** `foes.js` counts the fuse,
    because a fuse is the mine's own business; the blast is in `game.js` because
    it is about everything else on the field. Nothing it clears is scored - the
    mine did it, not the player - and mines caught in it go without going off,
    which is what keeps one blast from becoming a chain of them.

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
* **Three letters for the top five, and dashes for the rest.** A score good
  enough for the first five is asked for initials before it goes in the table;
  anything below that goes in as it was got, under three dashes. There is no
  sense making somebody spell their name for ninth place.
* **The game over card joins the rotation rather than replacing it.** The
  welcome alternates with the table, and after a game the game over card comes
  round with them - game over, welcome, table, and back. Dropping the table
  from the rotation after a game would mean the only way to see where a score
  landed was to have been watching before the first game was ever played.
* **A keyboard plays it too** — W A S D to fly, the arrows to turn, space,
  shift and B. The prompt asks for a pad and the pad is the game; this is so
  the page can be opened on a laptop with nothing plugged in.
* **The guns climb three times more slowly than they did.** Doubling the foes
  and adding four kinds put a great deal more on the screen, but the wait
  between shots halving every thousand points had both guns at the
  twenty-millisecond floor before the second level and nothing left for the rest
  of the game to give. Halving every three thousand leaves the climb going as
  far as the levels do.
* **Snakes are worth 250 and mines 50**, neither of which the prompt says. A
  snake takes five clean hits on a head that will not hold still, so it is worth
  more than a circle's four; a mine is one shot but it is a shot taken with
  something chasing, so it is worth more than a square. An egg is the 500 the
  prompt gives, and shooting one is the -50 it gives.
* **The hit that takes the last two triangles is the one the head does not
  survive.** "Reduce the size of the snake by 2 triangles before no tail left
  and the head explodes" is read as five hits rather than six: the tail empties
  and the head goes with it, rather than standing bare waiting for one more.
* **An egg is not an obstacle.** Flying into one catches it; it is the only
  thing on the field that does not end the game, and the only thing an EMP does
  not clear. A bomb that docked the player fifty for an egg they could not have
  known was under it would be a trap rather than a rule.
* **The score never goes below nothing.** Shooting an egg costs fifty, and both
  the rate of fire and the speed of the foes are read off the score - a negative
  score would read as a fresh game with a fresh sky.
* **Nothing arrives during a shower, and no clock runs towards arriving.** A
  shower is a held breath and it would be no rest at all if the wave clocks came
  out of it all expired at once. What is already on the field goes on flying,
  and goes on being lethal.
* **Comets are lethal.** The prompt does not say so, but a thing that cannot be
  shot and cannot be scored has to be worth dodging or it is scenery. Ten
  seconds of it, fifteen the next time, and five more every time after that.
* **A mine's blast pays nothing.** It clears five rockets' lengths of field,
  which would otherwise be the cheapest hundred points in the game.
* **Ninety shapes at once became sixty.** Every foe is twice the size it was, so
  the same count is twice the wall. The cap is read before a wave is let out
  rather than during one, so a fleet of ten can carry the field over it by as
  much as its own size.

## Layout

```
+-----------------------------------------------------------+
| SCORE 1240                        BEST 8400   EMP 2        |   drawn, like everything else
| LEVEL 2                                                    |
|                     .        .          .                  |
|            /\                     [ ]                      |   foes, in world space
|                 <|            .          <<<<<<<<<<        |   a snake: head, then its tail
|      .            \                                        |
|                    \___                                    |   the laser, nose to hit
|                      <| >                                  |   the rocket
|                                          O        (0)      |   a circle, and a mine
|          .                   .    ' . `                    |   and dust, where one used to be
+-----------------------------------------------------------+
   the canvas is the window; the world is a fifth larger than it

and between one level and the next, for ten seconds and then fifteen:

+-----------------------------------------------------------+
| SCORE 2010        COMET SHOWER 7      BEST 8400   EMP 1    |
| LEVEL 2                                                    |
|      oOo-.                                                 |
|                    oOo-.                                   |   all one way, and none of them
|            oOo-.                                           |   can be shot at
|                             oOo-.                          |
|                      <| >                                  |
+-----------------------------------------------------------+
```

And what comes round between games, six seconds a card, Start at any point:

```
   before a game            after one
   +-----------+            +-----------+
   |  WELCOME  |<--+     +->| GAME OVER |
   +-----------+   |     |  +-----------+
         |         |     |        |
         v         |     |        v
   +-----------+   |     |  +-----------+
   |  SCORES   |---+     |  |  WELCOME  |
   +-----------+         |  +-----------+
                         |        |
     START -> the game   |        v
     the game -> over    |  +-----------+
                         +--|  SCORES   |
                            +-----------+

   and in between, once, for a score in the first five:
   +-------------------+
   | TOP FIVE  N E B   |  the stick spells it, Start is done with it
   +-------------------+
```

## Files

| file | what it is |
| --- | --- |
| `index.html` | one canvas, and the scripts |
| `styles.css` | that the page is black and the canvas is all of it - and `error.html`, which has no canvas to say it with |
| `font.js` | the 8x8 dot matrix font, vendored from `example/font.js` |
| `text.js` | writing with it: a glyph, a line, a line centred |
| `screens.js` | the cards - welcome, table, game over, three letters, held - and the score along the top |
| `world.js` | the world, the camera, the dots, and everything that is a distance |
| `foes.js` | the six kinds: their table, how they arrive, how they move, where they can be hit, what a hit does |
| `dust.js` | what is left of a shape: a ring of grains off its outline, thrown and fading |
| `comets.js` | the comet shower - how long one lasts, and the weather in it |
| `weapons.js` | the rate of fire, the ray arithmetic both guns use, the torpedo |
| `input.js` | the pad and the keyboard, read into one intent |
| `scores.js` | the top ten, in whatever store is handed over |
| `game.js` | the rocket, the levels, the waves, the shots, the score, and one frame of all of it |
| `render.js` | the painting, and the only place the screen and the world meet |
| `grinder.js` | the page: the rotation, the loop, the spelling, the wiring |
| `sw.js` | the cache, so it plays with the aeroplane mode on |
| `error.html` | for a browser with no canvas |

## Tests

`tests/grinder.test.js`, against `tests/helpers/grinderPage.js`.

Every file but `grinder.js` is loaded into one shared scope — the same one the
script tags give them — and tested as itself: the world's arithmetic, the
circle's mending rule, the wave shapes, the rate of fire, the tunnelling a
torpedo must not do, the pad's dead zone and its press-not-hold bomb, the table
of scores, a game played frame by frame through `game.step`, the font's bit
order and its run-merging, and what every card says.

The additions of the second update are tested the same way: the snake's reveal,
the spacing of its tail along the path its head flew, a tail hit that lights up
and does nothing against a head hit that sheds two triangles, the egg's five
seconds and what catching one is worth against shooting one, a mine turning onto
the rocket and the blast that pays nothing, the shower's ten-then-fifteen
seconds and the level it opens, a laser passing clean through a comet, the
rocket's wind-up and its glide, and the dust a shape leaves. There is a minute
of a game with one of every kind on the field, checking that nothing in it goes
non-finite and that the dust settles.

`grinder.js` is tested through a stub DOM: the cards turning over on their own,
Start beginning a game from the welcome and from the game over, the three
letters spelt on the stick and typed on a keyboard, a score too low to be asked
for any, the hold on Escape, a resize, and a browser with no canvas being sent
to `error.html`. Nothing is drawn — the canvas takes the calls and throws them
away.
