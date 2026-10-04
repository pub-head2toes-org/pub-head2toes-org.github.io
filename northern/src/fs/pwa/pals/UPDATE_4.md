# UPDATE 4 - PWA Pals

Focus on checking the sign in session, continuation from update 3

# Currently:

In case when session cookie is expired the notice and link `sign in again` is added as per update 3

# Findings reported by test user

If the message is ignored and attempt is made to send a new message, the error in sending will occur: `Not delivered...`

# New strategy to implement
* To avoid user confusion and frustration as described above implement the redirect to `Reg.html` page in such case when session check finds out expired cookie.
* Second change should happen on `Reg.html` page when it is discovered that user was signed in previously but the session is experied. In this case hide the `Reg` panel.
  * The goal with hiding the `Reg` panel is to nudge user into singing with the existing user rather than by mistake create bunch of new users because it was not obvious what is the expected action in most situations, and that is to sign again with the same user as before because the session is expired. For a brand new user opening the Northern app for the first time there will be no previous user so the `Reg` panel will not be hidden.
* Third change is to add on the `Pals` on the bottom of the index page current version. Put there the same version number as it is used as app cache version.
