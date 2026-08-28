# Northern - Improvements - 3

Focus: On users and authentication

## Signin & Registration

### Improve UI and UX for Reg.html

* There are two headers naming the site: `head2toes` and `pub.head2toes.org`
  * Keep just one on top: `pub.head2toes.org`
* UX is not clear for username and passphrase: it is used in Reg but also in the Sign in as well
  * Split page into three main sections:
    * Message section
      * Move here the current text area
      * Re-purpose it as a general message board
      * Set it to be read only
      * Set it to use the whole width
    * Sign section
      * Add the optional input field for passphrase
      * Change `Load Id Card` button to `Load Id Card & Continue`
    * Reg section
      * Leave there the input fields for user name and passphrase
      * Add read only input field to show the newly generated pub key (no need to show priv key)
      * Keep only `Save Id Card & Continue` button and remove `Continue` button

