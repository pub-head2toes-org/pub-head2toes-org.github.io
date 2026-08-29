# Plan: (PWA) Chestnut - A chess board with game moves editor

A single page PWA under `/pwa/chesnut/`. Developed as pure HTML, JS and CSS app.

# Implementation Considerations

* Evaluate the way to use this open source game engine: `https://github.com/josefjadrny/js-chess-engine`

## Rendering

* Horizontal layout
* Header section:
  * Message bar
  * Action buttons bar
* Main section:
  * Left centered chess board
    * Render as HTML canvas and SVG
  * Right centered game moves list
    * first line as select field in case there are multiple variations
    * Render as read only text area with one move per line
    * match the height of the game board on the left

## Features

* game should be recorderd with standard Algebraic notation using Portable Game Notation text
* play - play the game with selected speed move by move from the list
* step - play one selected move from the list
* setup - initial pieces setup on the board
  * as standard pieces
  * as puzzle (with selected pieces)
* edit - edit game moves
  * move up/down on the game moves list
  * add move
  * delete move
  * add comment
* puzzle mode - board setup and solution moves
* analyze - use the game engine to find possible best response for the current board
* variations - allow for game moves lists for a possible different variations
* upload game moves from file
* download game moves to file
