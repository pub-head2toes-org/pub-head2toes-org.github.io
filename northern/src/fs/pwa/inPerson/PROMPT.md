# PWA InPerson

The PWA InPerson is for video calls in person.

## Consideration details
* Welcome page
  * To register for push notifications (similar like in PWA Pals)
  * Set a configuration for WebRTC configuration of STUN/TURN server
* The main page should have the `Contacts` list of contacts, using the same source that was used by PWA Pals to add contacts
  * Button `Call` that will start the call sequence
    * Send the push notification
    * Start the WebRTC connection
  * Two areas for video: `Self` and `Contact`
 

## Feasibility spike
* Compose an example of using the `Coturn` server: `https://github.com/coturn/coturn`
  * Consider configuration in case the Claudflare tunnel is used
* Compose an example of using `Claudflare` service: https://developers.cloudflare.com/realtime/turn/
* Prepare a plan for porting the video call feature to PWA `Pals`

