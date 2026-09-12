# UPDATE 5

Focus on Northern and the way `.md` files are rendered.

# Instructions

* rendering of `.md` files is implemented in `northern/src/fs/script-md.js` in function `function loadPage(url)`
* current implementation is using the github API to convert the markdown to HTML
* required change would be to switch this conversion to use opensource `showdownjs` as it is done in this version: `script-md.js`

