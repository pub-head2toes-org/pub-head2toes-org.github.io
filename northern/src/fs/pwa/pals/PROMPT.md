# PWA Pals

* Pals progressive web app enable messaging among close friends on many platforms thanks to using browsers API and PWA. 
* Uses Web Push API to notify users about incoming messages in real time.
* Uses cryptography to provide signatures as proof of identity.
* Uses self-hosted service to enable communication flow of messages.

## Implementation considerations for UI

* Use this code as an example of what the service can be, based on `northern` server and DB.
  * `/example/OpenChannel`
* Use plain HTML, JS and CSS
* UI
  * One page app
  * If there is no signed in user in the Northern web app, redirect to `Reg.html` with callback to this page again after reg or sign in
  * index.html
    * First section: Show the currently signed in into Northern user name
    * Next section: Show the invite URL: <current_host>/<current_user_pub_key>
    * Next section: Three panels aligned horizontally 
      * First panel: 
        * First row: Title: Pals
        * Next row: Text area with a list of usernames with first 5 letters of pub key in parentheses
        * Next row: Buttons: `+`, `-' to add or remove user
      * Next panel:
        * First row: Title: Log
        * Next row: Text area with a list of messages
          * Message to take two rows in the text area:
            * First row: Start of the message with first 128 chars
            * Second row: Username and first 5 letters of pub key in parentheses on the oval colored background
            * On click of message the overlay to pop up with the whole message in the text area
        * Next row: Buttons: `+` to add a message
      * Next panel:
        * Two vertically stacked panels
          * Upper panel
            * Title: Groups
            * Next row: Text area with a list of group names
              * On group name select:
                * Load group members in the lower panel
                * Load messages in the `Log` panel
            * Next row: Buttons: `+`, `-` to add new group or remove selected group
          * Lower panel
            * Title: Group members
            * Next: Text area with list of member usernames
              * On click on member:
                * Load messages in the `Log` panel with messages only sent by the group member
            * Next: Buttons: `+`, `-` to add or remove group member
    * Next section: 
      * Title: Incoming messages
      * Next row: Text area with a list of usernames of incoming messages
        * On push notification add username on top of the list
        * On-click on username to load messages in `Log` panel


## API architecture evaluation

* Start with a plan to evaluate different architecture options
  * First option
    * Use Push API with VAPID header signatures to identify push notification sender
      * Explore the option for using the EC key pair generated in Northern user registration process for use as VAPID keys, too
    * Use the Push API to send ping to start the conversation
    * Once ping is received use Northern `sub` for sending encrypted messages through the `sub` Server Sent Event (SSE) channel
      * Encryption should be done using the same mechanism VAPID is using to encrypt the push notification message body
    * The goal is not to save any message on the server that hosts the Northern server and use the zero-trust channel for sending messages
    * Store the Pals usernames and public keys as well as messages in the browser local storage in encrypted format
  * Second option
    * Save the messages in the Northern DB in encrypted format
    * Use the same method for signing and encrypting the messages as in the first option (based on VAPID)
    * Use the Push API to send notification that message is saved in the Northern DB
    * Goal is the same zero-trust channel utilization with ability to save messages on the server if the user is not online or cannot respond immediately 
    * Keep the option to store pals username and pub keys and message copies in the browser local storage 
      * Explore the option of deleting the message from the server after reading and copying into the browser local storage 
 
  
