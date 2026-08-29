# Plan: (PWA) Chestnut — a chess board with an editor for the game

A single-page PWA under `/pwa/chestnut/`: a board on the left, the game written
out on the right, and everything the header offers acting on one or the other.
The rules come from [js-chess-engine](https://github.com/josefjadrny/js-chess-engine)
(MIT, vendored as `js-chess-engine.js`); the notation, the move tree and the
editing are ours.

## Entry

`index.html` — nothing to join, no network, no parameters. The game that was
open last time is in `localStorage` and comes back with the page.

`error.html` is reached only when the browser has no `canvas` or the engine did
not load: the squares are drawn on a canvas and the legal moves come out of the
engine, so without either there is no board and no game.

## Architecture decisions

1. **A position is a FEN, and nothing else.** `chess.js` takes a FEN in and
   gives a FEN out; it keeps no board between calls. That costs a rebuilt board
   on every question asked, which for 64 squares is nothing, and it buys a model
   with no mutable state to get out of step — every move in the game, in any
   variation, carries its own position and can be shown without replaying
   anything to reach it.
2. **The engine does not know notation; we do.** `js-chess-engine` answers
   "which moves are legal" and "what would you play". Algebraic notation — the
   disambiguation, the capture mark, `=N`, `O-O`, the check and mate suffix — is
   `chess.san`, and reading it back is `chess.parse`, which works by writing out
   every legal move and looking for the one that reads the same. Writer and
   reader are then the same code, so they cannot disagree about a wrinkle.
3. **Promotion is ours too.** The engine promotes to a queen and offers no say
   in it. `chess.move` puts the asked-for piece on the square afterwards, which
   is the same board by another route, and underpromotion survives a trip
   through a PGN file.
4. **The game is a tree, and a variation is only an order.** A node is a move
   and the position it made; its first child is what was played next and any
   further children are variations. The main line, the variations and the
   difference between them all fall out of that one rule — `Main` in the edit
   bar is `children.unshift`, and nothing else in the file knows what a
   variation is.
5. **Editing a move list is not list work.** Take one ply out and every move
   after it changes hands, so `game.remove` tries the tail twice — as it stands,
   and without the reply that followed, which puts the colours back — and keeps
   whichever leaves more of the game. `game.shift` moves a move past the same
   player's move before or after it, two lines rather than one, for the same
   reason: swapping with the line above would hand the move to the other player
   and could never be played. Whatever will not play is dropped and counted, and
   the message bar says what the edit cost. Nothing is kept that the board would
   not allow.
6. **The squares are a canvas and the pieces are an SVG.** Both are placed by
   `board.js` from one number — the side of the board — so they cannot drift
   apart, and the board is whatever size the window leaves it with no table of
   measurements anywhere. The canvas is repainted from the state on every change
   and keeps nothing; the SVG keeps the pieces as elements, so the browser
   scales the glyphs rather than us redrawing them at every size.
7. **The pieces are Unicode, in the solid glyphs for both colours, asked for as
   text.** The outlined set is hollow, so a white piece drawn from it would show
   the square through its body; White is told apart by fill and outline instead.
   Each glyph carries U+FE0E after it — without that variation selector a font
   may answer with the emoji form, which is a picture: three dimensional, in its
   own colours, and deaf to the fill it is given, so White's pawn and Black's
   arrive looking the same. `font-variant-emoji: text` and a font stack that
   reaches the symbol fonts before any emoji font say it twice. No image files,
   no licence to carry, and a board that is legible at any size.
8. **The row is measured, not guessed at.** The board is sized against the row
   it sits in, and the row is `flex: 1 1 0` with `overflow: hidden` so it is
   exactly what the header leaves — on `flex: auto` a board too big for the
   space grows the row instead, and a centred row that has outgrown its space
   spills at both ends, which is a board drawn over the buttons above it. What
   is measured is the row's *content* box: its padding is not room the board can
   have, and sizing to the border box leaves the board that much too tall. A
   `ResizeObserver` on the row catches the header wrapping onto a second line,
   which no window resize event announces.
9. **One move to a line in the text area.** The list is read-only, as asked, so
   the caret is what points at a move: the app moves it to say which move the
   board is showing, and a tap moves it back to say which move to go to. One ply
   to a line is what makes that unambiguous.
10. **Everything is said in one place.** The message bar reports the move, the
   check, the mate, what an edit cost, what a file held and what the engine
   thinks. There are no dialogs except the two that ask for text — a move to add
   and a note to write — and no state hidden in a control.
11. **Nothing off the network.** The engine is vendored and `sw.js` caches
    everything, so the app is fully playable offline.

## Layout

```
+-----------------------------------------------------+
| #message   what just happened                       |
| #actions   play through | engine | board | files    |
+-----------------------+------------------+--------+
|                       | #variation  line | #pal-   |
|   #board              | #movetext   one  | ette    |
|   canvas + SVG,       |   move to a line,| pieces  |
|   square, as tall     |   caret on the   | to put  |
|   as the row          |   move shown     | down,   |
|                       | #editbar  editing| set-up  |
+-----------------------+------------------+--------+
```

The board is a square as tall as the row it sits in and the move list is given
the same height — which is why the size in pixels is worked out in `chestnut.js`
rather than left to the stylesheet: a canvas needs a number. Below an aspect
ratio of 5:4 the row becomes a column, board first.

The set-up palette is a column to the right of the move list rather than a bar
under the board, and it is only there while a position is being set up. Height
is the scarcest thing the board has; taking a strip of width for the pieces
costs it nothing.

## Controls

| Control | Does |
| --- | --- |
| ⏮ ◀ ▶ ▶❘ ⏭ | The start, back one, play through, on one, the end |
| Speed | 2s, 1s, 0.5s or 0.2s a move while playing through |
| Analyze | What the engine would play here, drawn as an arrow. Play it on the board to take it |
| Level | 0 to 3, how hard the engine thinks |
| Flip | Turn the board round |
| Setup | Put a position together by hand: a piece from the palette, then a square |
| Edit | Show the edit bar and, in a puzzle, show the moves |
| Puzzle | Hide the moves after the one on the board |
| Reveal | One move of the solution (a puzzle only) |
| New / Load / Save | A fresh game, a PGN file in, a PGN file out |
| ▲ ▼ | Move a move past the same player's move before or after it |
| ＋ − “” | Add a move by notation, take this move out, note against it |
| Main | Make this variation the main line at its branch point |

Keys: `←` `→` step, `Home` `End` jump, space plays through, `f` flips.

## Files

| File | Holds |
| --- | --- |
| `chess.js` | The rules and the notation. FEN in, FEN out |
| `board.js` | Squares to pixels, and back. No drawing |
| `pgn.js` | PGN as text: tags, movetext, comments, variations |
| `game.js` | The move tree, the editing, and the move list as text |
| `chestnut.js` | The page: drawing and listening, and nothing else |
| `js-chess-engine.js` | The engine, vendored (MIT, © 2020 Josef Jadrny) |

The first four touch no DOM and are tested as data in `tests/chestnut.test.js`;
`chestnut.js` is tested through the stub DOM in
`tests/helpers/chestnutPage.js`, where a click is aimed at a square with the
app's own geometry.

## Puzzles

A puzzle is a position and a solution: set the board up, turn `Puzzle` on, and
the moves after the one on the board read as `1. ?`. `Reveal` gives one back at
a time, and playing the right move on the board steps into it — a wrong one
joins as a variation rather than overwriting the solution. It travels in the
PGN as `[SetUp "1"]`, `[FEN ...]` and `[Puzzle "1"]`, so a puzzle is a file like
any other game.

## What was left out

* **Underpromotion in the setup palette** — a promotion is asked for with a
  prompt when the pawn arrives. The board itself never needs a chooser.
* **Draw claims** — threefold repetition and the fifty-move rule are not
  claimed. Checkmate and stalemate are reported; the half-move clock is carried
  in the FEN but nothing acts on it.
* **A clock** — this is a board for looking at games, not for playing them
  against time.
* **Variations of variations in a rewritten tail** — an edit rewrites the moves
  after it, and side lines hanging off what was rewritten do not survive. The
  message bar says how many moves were dropped; it does not itemise them.
