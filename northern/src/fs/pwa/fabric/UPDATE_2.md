# PWA Fabric - Update 2

The focus of this update is to introduce a new feature to the existing PWA Fabric.

Objective: New feature - The key stroke listener on the top layer that contains the HTML canvas that can recognize the string representing a command. 

## Implementation considerations

* Commands are the key presses that start with `{` and have a format like: {"cmd":"copy"}
* The goal is to allow keyboard inputs to improve UX (that might be coming from a smart HID BLE keyboard like HIDRA)
  * Benefit is to improve UX by eliminating the need to peel off constantly to the control layer to be able to reach controls
* Commands that need to be recognized and are the equivalent to the command available on the second layer of the current PWA Fabric implementation
  * Commands and the JSON strings (in `fabric` context)
    * `esc` - {"cmd":"escape"}
    * `cp` - {"cmd":"copy"}
    * `paste` - {"cmd":"paste"}
    * `rm` - {"cmd":"remove"}
    * `select` - {"cmd":"select"}
    * `on` - {"cmd":"turn-on"}
    * `off` - {"cmd":"turn-off"}
    * `pencil` - {"cmd":"pencil"}
    * `line` - {"cmd":"line"}
    * `rect` - {"cmd":"rectangle"}
    * `circle` - {"cmd":"circle"}
    * `textbox` - {"cmd":"text-box"}
    * `bubble` - {"cmd":"bubble"}
    * `loadimg` - {"cmd":"load-image"}
    * `loadjson` - {"cmd":"load-json"}
    * `dnl-img` - {"cmd":"download-image"}
    * `dnl-json` - {"cmd":"download-json"}
    * `dnl-selected - {"cmd":"download-selected-image"}`
    * `fit-width` - {"cmd":"fit-width"}
    * `fit-height` - {"cmd":"fit-height"}
  * The key-press listener should detect the start of the command sequence: `{`, then buffer characters until it's end: `}`
    * For the detected command sequence, the recognized commands should reuse the actions as they were implemented on the current control layer



