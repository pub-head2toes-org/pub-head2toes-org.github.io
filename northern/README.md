# Northern

Northern is a Node JS wrapper app around relational DB (Sqlite) that exposes the REST API interface as the key value database. The key is the HTTP request path and the value is the HTTP request body.

It is an HTTP REST based database for persisting JSON.
 
## Common services to build upon

* Call to HTTP POST with URL path and JSON payload will create record
* PUT will update
* GET will retrieve data

## User & Authentication

The notion behind the user and authentication:
* Registration
* ID card
* Public & Private key asymmetric cryptography
* Authentication
* Digital signature in the HTTP cookie as a proof of authentication

## File system

The name space that is defined with the key prefix is used to implement read only serving of values from the file system instead from the RDBMS (sqlite).

`/fs/get` prefix indicates that the value is going to be retrieved from the file system.

## Console & Editor

HTML, JS and CSS implementation of command line console and editor is served from the file system:

`/fs/get/keyboard.html`

The console can be used to invoke DB operations implemented as standard HTTTP operations over the built-in browser Fetch API.

The integrated editor is used to show the results or to prepare the new inputs.

The values stored in DB could be JSON strings, but also HTML, JS and CSS strings. This way the DB with the REST API doubles as a standard web server.


