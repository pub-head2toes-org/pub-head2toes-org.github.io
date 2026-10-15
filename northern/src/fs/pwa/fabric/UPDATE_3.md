# PWA Fabric - Update 3

The focus of this update is to improve the keyboard listener.
Additional feature: 
* Ability to set Z-index for objects
* Zoom level

Objective: Allow keyboard shortcuts to the commands using CTRL and ALT keys. 

## Implementation considerations

* Command shortcuts
  * Commands shortcuts and the JSON strings (in `fabric` context)
    * CTRL-c - `cp` - {"cmd":"copy"}
    * CTRL-v - `paste` - {"cmd":"paste"}
    * CTRL-r - `rm` - {"cmd":"remove"}
    * CTRL-s `select` - {"cmd":"select"}
    * CTRL-o - `on` - {"cmd":"turn-on"} - A flip for `on` and `off`
    * ALT-p - `pencil` - {"cmd":"pencil"}
    * ALT-l - `line` - {"cmd":"line"}
    * ALT-r - `rect` - {"cmd":"rectangle"}
    * ALT-c - `circle` - {"cmd":"circle"}
    * ALT-t - `textbox` - {"cmd":"text-box"}
    * CTRL-i - `loadimg` - {"cmd":"load-image"}
    * CTRL-j - `loadjson` - {"cmd":"load-json"}
    * CTRL-W - `fit-width` - {"cmd":"fit-width"}
    * CTRL-H - `fit-height` - {"cmd":"fit-height"}
* Additional features in the control layer
  * Z-index - for a selected object set the overlay index to determine overlapping order of objects
  * Zoom level - allow the whole canvas to zoom in and out
    * Add the command shortcuts
      * CTRL-+ zoom one level in
      * CTRL-- zoom one level out




